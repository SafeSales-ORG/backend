import type { FastifyRequest } from 'fastify';
import type { Dispute, DisputeMessage, DisputeParty, Order, Seller } from '@prisma/client';
import { prisma } from '../db/client.js';
import { Conflict, Forbidden, NotFound, Unauthorized } from '../lib/errors.js';
import { verifyToken } from './auth.js';

export type Party = Exclude<DisputeParty, 'system'>;
export type RequestTarget = 'buyer' | 'seller' | 'both';

/** How long a party has to answer the mediator's question. */
const INFO_REQUEST_MS = 48 * 60 * 60 * 1000;

type DisputeWithOrder = Dispute & { order: Order & { seller: Seller } };

/**
 * Who is looking at this dispute: the mediator, the seller (signed in), or
 * the buyer (signed in, or holding the order's secret buyer token).
 */
export async function partyFor(request: FastifyRequest, disputeId: string) {
  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: { order: { include: { seller: true } } },
  });
  if (!dispute) throw new NotFound('Dispute not found');

  // The buyer's order link wins: the same browser may also hold a seller
  // session (people buy from each other).
  const buyerToken = request.headers['x-buyer-token'];
  if (typeof buyerToken === 'string' && buyerToken === dispute.order.buyerToken) {
    return { dispute, party: 'buyer' as Party, userId: null };
  }

  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    let user;
    try {
      user = verifyToken(header.slice(7));
    } catch {
      throw new Unauthorized('Invalid or expired token');
    }
    if (user.role === 'MEDIATOR') return { dispute, party: 'mediator' as Party, userId: user.sub };
    if (dispute.order.seller.userId === user.sub) return { dispute, party: 'seller' as Party, userId: user.sub };
    if (dispute.order.buyerId === user.sub) return { dispute, party: 'buyer' as Party, userId: user.sub };
  }

  if (!header) throw new Unauthorized('Sign in, or open your order link, to see this case');
  throw new Forbidden('You are not part of this dispute');
}

/** Whose move it is: parties the mediator is waiting on, else the mediator. */
export function waitingOn(
  status: Dispute['status'],
  messages: Pick<DisputeMessage, 'authorRole' | 'requestFrom'>[],
): Party[] {
  if (status === 'resolved') return [];
  let lastRequest = -1;
  messages.forEach((m, i) => {
    if (m.authorRole === 'mediator' && m.requestFrom) lastRequest = i;
  });
  if (lastRequest >= 0) {
    const target = messages[lastRequest].requestFrom as RequestTarget;
    const wanted: Party[] = target === 'both' ? ['buyer', 'seller'] : [target];
    const after = messages.slice(lastRequest + 1);
    const pending = wanted.filter((p) => !after.some((m) => m.authorRole === p));
    if (pending.length) return pending;
  }
  return ['mediator'];
}

export function threadMessage(m: DisputeMessage, names: { buyer: string; seller: string }) {
  const authorName =
    m.authorRole === 'buyer'
      ? names.buyer
      : m.authorRole === 'seller'
        ? names.seller
        : m.authorRole === 'mediator'
          ? 'SafeSale mediator'
          : 'SafeSale';
  return {
    id: m.id,
    authorRole: m.authorRole,
    authorName,
    content: m.content,
    attachments: Array.isArray(m.attachments) ? (m.attachments as string[]) : [],
    requestFrom: (m.requestFrom as RequestTarget | null) ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

export function partyNames(dispute: DisputeWithOrder) {
  return { buyer: dispute.order.buyerName, seller: dispute.order.seller.name };
}

/**
 * Add a message to the case and move the dispute along:
 *  - the mediator asking someone a question → evidence_requested (48h clock)
 *  - the mediator joining otherwise → mediating
 *  - everyone asked has answered → back to mediating
 * Buyer and seller photos also join the dispute's evidence list.
 */
export async function postToThread(params: {
  dispute: DisputeWithOrder;
  party: Party;
  userId: string | null;
  content: string;
  attachments: string[];
  requestFrom?: RequestTarget;
}) {
  const { dispute, party, userId, content, attachments } = params;
  if (dispute.status === 'resolved') throw new Conflict('This case is closed');
  const requestFrom = party === 'mediator' ? params.requestFrom : undefined;

  return prisma.$transaction(async (tx) => {
    const message = await tx.disputeMessage.create({
      data: {
        disputeId: dispute.id,
        authorId: userId,
        authorRole: party,
        content,
        attachments,
        requestFrom: requestFrom ?? null,
      },
    });

    const all = await tx.disputeMessage.findMany({
      where: { disputeId: dispute.id },
      orderBy: { createdAt: 'asc' },
      select: { authorRole: true, requestFrom: true },
    });
    const next = waitingOn(dispute.status, all);

    const data: Record<string, unknown> = {};
    if (requestFrom) {
      data.status = 'evidence_requested';
      data.evidenceDueAt = new Date(Date.now() + INFO_REQUEST_MS);
    } else if (party === 'mediator' && dispute.status !== 'evidence_requested') {
      data.status = 'mediating';
    } else if (dispute.status === 'evidence_requested' && next.length === 1 && next[0] === 'mediator') {
      data.status = 'mediating';
      data.evidenceDueAt = null;
    }
    if (party !== 'mediator' && attachments.length) {
      const existing = Array.isArray(dispute.evidence) ? dispute.evidence : [];
      const at = message.createdAt.toISOString();
      data.evidence = [...existing, ...attachments.map((url) => ({ url, by: party, at }))];
    }
    if (Object.keys(data).length) {
      // Never touch a case that was settled in the meantime.
      await tx.dispute.updateMany({ where: { id: dispute.id, status: { not: 'resolved' } }, data });
    }
    return message;
  });
}

const OUTCOME_TEXT = {
  refund_buyer: 'refund the buyer in full',
  release_seller: 'pay the seller in full',
  split: 'split the money',
} as const;

/** System note written when the mediator settles the case. */
export async function recordDecision(params: {
  disputeId: string;
  userId: string;
  outcome: keyof typeof OUTCOME_TEXT;
  buyerRefundNGN: number;
  sellerReleaseNGN: number;
  rationale: string;
}) {
  const naira = (n: number) => `₦${n.toLocaleString('en-NG')}`;
  const parts = [
    params.buyerRefundNGN > 0 && `${naira(params.buyerRefundNGN)} back to the buyer`,
    params.sellerReleaseNGN > 0 && `${naira(params.sellerReleaseNGN)} to the seller`,
  ].filter(Boolean);
  await prisma.disputeMessage.createMany({
    data: [
      { disputeId: params.disputeId, authorId: params.userId, authorRole: 'mediator', content: params.rationale },
      {
        disputeId: params.disputeId,
        authorRole: 'system',
        content: `Case closed. The mediator decided to ${OUTCOME_TEXT[params.outcome]}: ${parts.join(' and ')}.`,
      },
    ],
  });
}
