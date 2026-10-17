import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { imageUrl } from '../lib/images.js';
import { prisma } from '../db/client.js';
import { Conflict, Forbidden, NotFound, Unauthorized, isUniqueViolation } from '../lib/errors.js';
import { optionalAuth, requireAuth, requireMediator } from '../middleware/auth.js';
import { normalizeOrder, normalizeSeller, normalizeListing, normalizeDispute } from '../lib/normalize.js';
import { resolveDispute } from '../services/escrow.js';
import { partyFor, partyNames, postToThread, recordDecision, threadMessage, waitingOn } from '../services/disputeThread.js';

// Evidence images arrive as compressed data: URLs or https URLs.
const Evidence = z.array(imageUrl(1_500_000)).max(6);

const OpenDisputeSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  summary: z.string().trim().min(1).max(500).optional(),
  openedBy: z.enum(['buyer', 'seller']),
  evidence: Evidence.optional(),
});

const AddMessageSchema = z.object({
  content: z.string().trim().min(1).max(2000),
  attachments: z.array(imageUrl(1_500_000)).max(4).optional(),
  // Mediator only: ask a party for information.
  requestFrom: z.enum(['buyer', 'seller', 'both']).optional(),
});

const RespondSchema = z.object({
  stance: z.enum(['explain', 'partial', 'full', 'counter']),
  message: z.string().trim().min(1).max(2000),
  evidence: Evidence.optional(),
});

const ResolveSchema = z
  .object({
    outcome: z.enum(['refund_buyer', 'release_seller', 'split']),
    // `buyerPercent` is the older name the frontend sent; accept both.
    splitPct: z.number().int().min(0).max(100).optional(),
    buyerPercent: z.number().int().min(0).max(100).optional(),
    rationale: z.string().trim().min(1).max(2000),
  })
  .refine((b) => b.outcome !== 'split' || b.splitPct !== undefined || b.buyerPercent !== undefined, {
    message: 'A split needs the buyer percentage',
    path: ['splitPct'],
  });

const MediatorUpdateSchema = z.object({
  // Resolution moves money, so it only happens via /resolve.
  status: z.enum(['direct_resolution', 'escalated', 'evidence_requested', 'mediating']),
});

function evidenceItems(urls: string[] | undefined, by: 'buyer' | 'seller') {
  const at = new Date().toISOString();
  return (urls ?? []).map((url) => ({ url, by, at }));
}

const IdParams = z.object({ id: z.string().min(1).max(64) });
const TokenParams = z.object({ token: z.string().min(8).max(128) });

async function loadDisputeForUser(disputeId: string, userId: string, role?: string) {
  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: { order: { include: { seller: true } } },
  });
  if (!dispute) throw new NotFound('Dispute not found');
  const isSeller = dispute.order.seller.userId === userId;
  const isBuyer = dispute.order.buyerId === userId;
  const isMediator = role === 'MEDIATOR';
  if (!isSeller && !isBuyer && !isMediator) throw new Forbidden('You are not a participant in this dispute');
  return { dispute, isSeller, isMediator };
}

async function mediatorDisputeList() {
  const disputes = await prisma.dispute.findMany({
    include: {
      order: { include: { listing: true, seller: true } },
      messages: { orderBy: { createdAt: 'asc' }, select: { authorRole: true, requestFrom: true, createdAt: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  return {
    disputes: disputes.map((d) => ({
      ...normalizeDispute(d),
      thread: {
        count: d.messages.filter((m) => m.authorRole !== 'system').length,
        lastAt: d.messages.at(-1)?.createdAt.toISOString() ?? null,
        lastFrom: d.messages.at(-1)?.authorRole ?? null,
        waitingOn: waitingOn(d.status, d.messages),
      },
      order: { ...normalizeOrder(d.order), listing: normalizeListing(d.order.listing) },
      seller: normalizeSeller(d.order.seller),
      listing: normalizeListing(d.order.listing),
    })),
  };
}

const disputesRoute: FastifyPluginAsync = async (app) => {
  /**
   * Open a dispute. The buyer uses their secret buyer token (no account
   * needed); the seller uses the order reference plus their session.
   * Opening a dispute pauses auto-release.
   */
  app.post('/api/orders/:token/dispute', { preHandler: [optionalAuth] }, async (request, reply) => {
    const { token } = TokenParams.parse(request.params);
    const body = OpenDisputeSchema.parse(request.body);

    const order =
      body.openedBy === 'buyer'
        ? await prisma.order.findUnique({ where: { buyerToken: token }, include: { seller: true } })
        : await prisma.order.findUnique({ where: { orderToken: token }, include: { seller: true } });
    if (!order) throw new NotFound('Order not found');

    if (body.openedBy === 'seller') {
      if (!request.user) throw new Unauthorized('Sign in to open a dispute as the seller');
      if (order.seller.userId !== request.user.sub) throw new Forbidden('You are not the seller of this order');
    }

    let dispute;
    try {
      dispute = await prisma.$transaction(async (tx) => {
        const claimed = await tx.order.updateMany({
          where: { id: order.id, status: { in: ['funded', 'shipped', 'delivered'] } },
          data: { status: 'disputed', autoReleaseAt: null },
        });
        if (claimed.count === 0) throw new Conflict(`Order can't be disputed while it is ${order.status}`);

        const created = await tx.dispute.create({
          data: {
            orderId: order.id,
            reason: body.reason,
            summary: body.summary,
            openedBy: body.openedBy,
            evidence: evidenceItems(body.evidence, body.openedBy),
          },
        });
        const naira = `₦${order.priceNGN.toLocaleString('en-NG')}`;
        await tx.disputeMessage.create({
          data: {
            disputeId: created.id,
            authorRole: 'system',
            content: `The ${body.openedBy} reported a problem. ${naira} stays held by SafeSale until a mediator decides. Everyone in this case can see these messages.`,
          },
        });
        await tx.disputeMessage.create({
          data: {
            disputeId: created.id,
            authorId: request.user?.sub ?? null,
            authorRole: body.openedBy,
            content: body.summary ? `${body.reason}\n\n${body.summary}` : body.reason,
            attachments: body.evidence ?? [],
          },
        });
        return created;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new Conflict('A dispute already exists for this order');
      throw err;
    }

    reply.code(201);
    return {
      order: normalizeOrder(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })),
      dispute: normalizeDispute(dispute),
    };
  });

  app.get('/api/disputes/:id', { preHandler: [requireAuth] }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const { dispute } = await loadDisputeForUser(id, request.user!.sub, request.user!.role);
    const messages = await prisma.disputeMessage.findMany({ where: { disputeId: id }, orderBy: { createdAt: 'asc' } });
    const names = partyNames(dispute);
    return { dispute: { ...normalizeDispute(dispute), messages: messages.map((m) => threadMessage(m, names)) } };
  });

  /**
   * The case thread. Buyer (order link token), seller and mediator all read
   * and write the same conversation while the money stays in escrow.
   */
  app.get('/api/disputes/:id/thread', async (request) => {
    const { id } = IdParams.parse(request.params);
    const { dispute, party } = await partyFor(request, id);
    const messages = await prisma.disputeMessage.findMany({ where: { disputeId: id }, orderBy: { createdAt: 'asc' } });
    const names = partyNames(dispute);
    return {
      viewer: party,
      dispute: normalizeDispute(dispute),
      waitingOn: waitingOn(dispute.status, messages),
      messages: messages.map((m) => threadMessage(m, names)),
    };
  });

  const postMessage = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = IdParams.parse(request.params);
    const body = AddMessageSchema.parse(request.body);
    const { dispute, party, userId } = await partyFor(request, id);
    const message = await postToThread({
      dispute,
      party,
      userId,
      content: body.content,
      attachments: body.attachments ?? [],
      requestFrom: body.requestFrom,
    });
    reply.code(201);
    return { message: threadMessage(message, partyNames(dispute)) };
  };
  const messageLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  app.post('/api/disputes/:id/thread', messageLimit, postMessage);
  app.post('/api/disputes/:id/messages', messageLimit, postMessage);

  /** Seller responds to a dispute. */
  app.post('/api/disputes/:id/respond', { preHandler: [requireAuth] }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = RespondSchema.parse(request.body);
    const { dispute, isSeller } = await loadDisputeForUser(id, request.user!.sub, request.user!.role);
    if (!isSeller) throw new Forbidden('Only the seller can respond to a dispute');
    if (dispute.status === 'resolved') throw new Conflict('This dispute is closed');

    const existing = Array.isArray(dispute.evidence) ? dispute.evidence : [];
    await prisma.$transaction([
      prisma.disputeMessage.create({
        data: {
          disputeId: dispute.id,
          authorId: request.user!.sub,
          authorRole: 'seller',
          content: body.message,
          attachments: body.evidence ?? [],
        },
      }),
      prisma.dispute.update({
        where: { id: dispute.id },
        data: {
          sellerResponse: body.message,
          // Append — never overwrite the buyer's evidence.
          evidence: [...existing, ...evidenceItems(body.evidence, 'seller')],
          ...(body.evidence?.length && { status: 'escalated' }),
        },
      }),
    ]);

    const updated = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id }, include: { order: true } });
    return { order: normalizeOrder(updated.order), dispute: normalizeDispute(updated) };
  });

  app.get('/api/mediator/disputes', { preHandler: [requireMediator] }, mediatorDisputeList);
  app.get('/api/admin/disputes', { preHandler: [requireMediator] }, mediatorDisputeList);

  app.patch('/api/mediator/disputes/:id', { preHandler: [requireMediator] }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = MediatorUpdateSchema.parse(request.body);

    const res = await prisma.dispute.updateMany({
      where: { id, status: { not: 'resolved' } },
      data: { status: body.status },
    });
    if (res.count === 0) throw new Conflict('Dispute not found or already resolved');
    return { dispute: normalizeDispute(await prisma.dispute.findUniqueOrThrow({ where: { id } })) };
  });

  /** Mediator settles a dispute: moves the money and closes it. */
  app.post('/api/admin/disputes/:id/resolve', { preHandler: [requireMediator] }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = ResolveSchema.parse(request.body);

    await resolveDispute({
      disputeId: id,
      outcome: body.outcome,
      buyerPercent: body.splitPct ?? body.buyerPercent ?? 50,
      rationale: body.rationale,
    });

    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id }, include: { order: true } });
    const settled = (dispute.resolution ?? {}) as { buyerRefundNGN?: number; sellerReleaseNGN?: number };
    await recordDecision({
      disputeId: id,
      userId: request.user!.sub,
      outcome: body.outcome,
      buyerRefundNGN: settled.buyerRefundNGN ?? 0,
      sellerReleaseNGN: settled.sellerReleaseNGN ?? 0,
      rationale: body.rationale,
    });
    return { order: normalizeOrder({ ...dispute.order, dispute }), dispute: normalizeDispute(dispute) };
  });
};

export default disputesRoute;
