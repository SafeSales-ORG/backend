import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { Conflict, Forbidden, NotFound, Unauthorized, isUniqueViolation } from '../lib/errors.js';
import { optionalAuth, requireAuth, requireMediator } from '../middleware/auth.js';
import { normalizeOrder, normalizeSeller, normalizeListing, normalizeDispute } from '../lib/normalize.js';
import { resolveDispute } from '../services/escrow.js';

// Evidence images arrive as compressed data: URLs or https URLs.
const Evidence = z
  .array(z.string().max(1_500_000).regex(/^(https:\/\/|data:image\/)/))
  .max(6);

const OpenDisputeSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  summary: z.string().trim().min(1).max(500).optional(),
  openedBy: z.enum(['buyer', 'seller']),
  evidence: Evidence.optional(),
});

const AddMessageSchema = z.object({
  content: z.string().trim().min(1).max(2000),
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
    include: { order: { include: { listing: true, seller: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  return {
    disputes: disputes.map((d) => ({
      ...normalizeDispute(d),
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

        return tx.dispute.create({
          data: {
            orderId: order.id,
            reason: body.reason,
            summary: body.summary,
            openedBy: body.openedBy,
            returnEvidence: body.evidence ?? [],
          },
        });
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
    await loadDisputeForUser(id, request.user!.sub, request.user!.role);
    const dispute = await prisma.dispute.findUniqueOrThrow({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    return {
      dispute: {
        ...normalizeDispute(dispute),
        messages: dispute.messages.map((m) => ({
          id: m.id,
          authorId: m.authorId,
          content: m.content,
          createdAt: m.createdAt.toISOString(),
        })),
      },
    };
  });

  app.post('/api/disputes/:id/messages', { preHandler: [requireAuth] }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = AddMessageSchema.parse(request.body);
    const { dispute } = await loadDisputeForUser(id, request.user!.sub, request.user!.role);
    if (dispute.status === 'resolved') throw new Conflict('This dispute is closed');

    const message = await prisma.disputeMessage.create({
      data: { disputeId: dispute.id, authorId: request.user!.sub, content: body.content },
    });
    return { message: { id: message.id, content: message.content, createdAt: message.createdAt.toISOString() } };
  });

  /** Seller responds to a dispute. */
  app.post('/api/disputes/:id/respond', { preHandler: [requireAuth] }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = RespondSchema.parse(request.body);
    const { dispute, isSeller } = await loadDisputeForUser(id, request.user!.sub, request.user!.role);
    if (!isSeller) throw new Forbidden('Only the seller can respond to a dispute');
    if (dispute.status === 'resolved') throw new Conflict('This dispute is closed');

    await prisma.disputeMessage.create({
      data: { disputeId: dispute.id, authorId: request.user!.sub, content: body.message },
    });
    if (body.evidence?.length) {
      await prisma.dispute.update({
        where: { id: dispute.id },
        data: { returnEvidence: body.evidence, status: 'escalated' },
      });
    }

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
    return { order: normalizeOrder(dispute.order), dispute: normalizeDispute(dispute) };
  });
};

export default disputesRoute;
