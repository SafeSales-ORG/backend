import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { BadRequest, NotFound, Forbidden } from '../lib/errors.js';
import { requireAuth, requireMediator } from '../middleware/auth.js';
import { normalizeOrder, normalizeSeller, normalizeListing, normalizeDispute } from '../lib/normalize.js';
import { transferToBank } from '../services/nomba.js';

const OpenDisputeSchema = z.object({
  orderToken: z.string().min(1),
  reason: z.string().min(10).max(2000),
  summary: z.string().min(10).max(500).optional(),
  isReturn: z.boolean().optional().default(false),
});

const AddMessageSchema = z.object({
  content: z.string().min(1).max(2000),
});

const FrontendOpenDisputeSchema = z.object({
  reason: z.string().min(1).max(2000),
  summary: z.string().min(1).max(500).optional(),
  openedBy: z.enum(['buyer', 'seller']),
  evidence: z.array(z.string()).optional(),
});

const FrontendRespondSchema = z.object({
  stance: z.enum(['explain', 'partial', 'full', 'counter']),
  message: z.string().min(1).max(2000),
  evidence: z.array(z.string()).optional(),
});

const FrontendResolveSchema = z.object({
  outcome: z.enum(['refund_buyer', 'release_seller', 'split']),
  splitPct: z.number().int().min(0).max(100).optional(),
  rationale: z.string().min(1).max(2000),
});

async function getDisputeParticipantCheck(disputeId: string, userId: string) {
  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: { order: { include: { seller: true } } },
  });
  if (!dispute) throw new NotFound('Dispute not found');

  const isParticipant =
    dispute.order.buyerId === userId ||
    dispute.order.seller.userId === userId;
  return { dispute, isParticipant };
}

const disputesRoute: FastifyPluginAsync = async (app) => {
  /* Backend-native: create dispute with orderToken in body */
  app.post('/api/disputes', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = OpenDisputeSchema.parse(request.body);

    const order = await prisma.order.findUnique({
      where: { orderToken: body.orderToken },
      include: { seller: true },
    });
    if (!order) throw new NotFound('Order not found');

    if (order.buyerId !== request.user!.sub && order.seller.userId !== request.user!.sub) {
      throw new Forbidden('You are not a participant in this order');
    }

    if (!['funded', 'shipped', 'delivered'].includes(order.status)) {
      throw new BadRequest('Order cannot be disputed in its current state');
    }

    const existing = await prisma.dispute.findUnique({ where: { orderId: order.id } });
    if (existing) throw new BadRequest('A dispute already exists for this order');

    const dispute = await prisma.dispute.create({
      data: {
        orderId: order.id,
        reason: body.reason,
        summary: body.summary,
        openedBy: request.user!.sub,
        isReturn: body.isReturn,
      },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'disputed' },
    });

    reply.code(201);
    return {
      order: normalizeOrder(order as unknown as Record<string, unknown>),
      dispute: normalizeDispute(dispute as unknown as Record<string, unknown> | null),
    };
  });

  /* Frontend-facing: create dispute from order token in URL */
  app.post<{ Params: { token: string } }>(
    '/api/orders/:token/dispute',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const body = FrontendOpenDisputeSchema.parse(request.body);

      const order = await prisma.order.findUnique({
        where: { orderToken: request.params.token },
        include: { seller: true, listing: true },
      });
      if (!order) throw new NotFound('Order not found');

      if (order.buyerId !== request.user!.sub && order.seller.userId !== request.user!.sub) {
        throw new Forbidden('You are not a participant in this order');
      }

      if (!['funded', 'shipped', 'delivered'].includes(order.status)) {
        throw new BadRequest('Order cannot be disputed in its current state');
      }

      const existing = await prisma.dispute.findUnique({ where: { orderId: order.id } });
      if (existing) throw new BadRequest('A dispute already exists for this order');

      const dispute = await prisma.dispute.create({
        data: {
          orderId: order.id,
          reason: body.reason,
          summary: body.summary,
          openedBy: request.user!.sub,
          returnEvidence: body.evidence ?? [],
        },
      });

      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'disputed' },
      });

      reply.code(201);
      return {
        order: normalizeOrder(order as unknown as Record<string, unknown>),
        dispute: normalizeDispute(dispute as unknown as Record<string, unknown> | null),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/disputes/:id',
    { preHandler: [requireAuth] },
    async (request) => {
      const dispute = await prisma.dispute.findUnique({
        where: { id: request.params.id },
        include: {
          order: { include: { seller: true } },
          messages: {
            include: { author: { select: { id: true, email: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      if (!dispute) throw new NotFound('Dispute not found');

      const isParticipant =
        dispute.order.buyerId === request.user!.sub ||
        dispute.order.seller.userId === request.user!.sub ||
        request.user!.role === 'MEDIATOR';
      if (!isParticipant) throw new Forbidden('You are not a participant in this dispute');

      return { dispute };
    },
  );

  /* Backend-native: add a message to a dispute */
  app.post<{ Params: { id: string } }>(
    '/api/disputes/:id/messages',
    { preHandler: [requireAuth] },
    async (request) => {
      const body = AddMessageSchema.parse(request.body);

      const { dispute, isParticipant } = await getDisputeParticipantCheck(request.params.id, request.user!.sub);
      if (!isParticipant && request.user!.role !== 'MEDIATOR') {
        throw new Forbidden('You are not a participant in this dispute');
      }

      const message = await prisma.disputeMessage.create({
        data: {
          disputeId: dispute.id,
          authorId: request.user!.sub,
          content: body.content,
        },
      });

      return { message };
    },
  );

  /* Frontend-facing: seller responds to a dispute */
  app.post<{ Params: { id: string } }>(
    '/api/disputes/:id/respond',
    { preHandler: [requireAuth] },
    async (request) => {
      const body = FrontendRespondSchema.parse(request.body);

      const { dispute, isParticipant } = await getDisputeParticipantCheck(request.params.id, request.user!.sub);
      if (!isParticipant) throw new Forbidden('You are not a participant in this dispute');

      const isSeller = dispute.order.seller.userId === request.user!.sub;
      if (!isSeller) throw new Forbidden('Only the seller can respond to a dispute');

      await prisma.disputeMessage.create({
        data: {
          disputeId: dispute.id,
          authorId: request.user!.sub,
          content: body.message,
        },
      });

      if (body.evidence && body.evidence.length > 0) {
        await prisma.dispute.update({
          where: { id: dispute.id },
          data: { returnEvidence: body.evidence, status: 'escalated' },
        });
      }

      const updated = await prisma.dispute.findUnique({
        where: { id: dispute.id },
        include: { order: { include: { listing: true, seller: true } } },
      });

      return {
        order: normalizeOrder(updated!.order as unknown as Record<string, unknown>),
        dispute: normalizeDispute(updated as unknown as Record<string, unknown> | null),
      };
    },
  );

  /* Frontend-facing: mediator dispute list (GET /api/admin/disputes) */
  app.get(
    '/api/mediator/disputes',
    { preHandler: [requireMediator] },
    async () => {
      const disputes = await prisma.dispute.findMany({
        include: {
          order: { include: { listing: true, seller: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
      });

      return {
        disputes: disputes.map((d) => ({
          ...normalizeDispute(d as unknown as Record<string, unknown>),
          order: {
            ...normalizeOrder(d.order as unknown as Record<string, unknown>),
            listing: normalizeListing((d.order as any).listing as unknown as Record<string, unknown>),
          },
          seller: normalizeSeller((d.order as any).seller as unknown as Record<string, unknown>),
          listing: normalizeListing((d.order as any).listing as unknown as Record<string, unknown>),
        })),
      };
    },
  );

  /* Frontend-facing alias: GET /api/admin/disputes */
  app.get(
    '/api/admin/disputes',
    { preHandler: [requireMediator] },
    async () => {
      const disputes = await prisma.dispute.findMany({
        include: {
          order: { include: { listing: true, seller: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
      });

      return {
        disputes: disputes.map((d) => ({
          ...normalizeDispute(d as unknown as Record<string, unknown>),
          order: {
            ...normalizeOrder(d.order as unknown as Record<string, unknown>),
            listing: normalizeListing((d.order as any).listing as unknown as Record<string, unknown>),
          },
          seller: normalizeSeller((d.order as any).seller as unknown as Record<string, unknown>),
          listing: normalizeListing((d.order as any).listing as unknown as Record<string, unknown>),
        })),
      };
    },
  );

  /* Backend-native: update dispute status/resolution */
  app.patch<{ Params: { id: string } }>(
    '/api/mediator/disputes/:id',
    { preHandler: [requireMediator] },
    async (request) => {
      const body = z.object({
        status: z.enum(['direct_resolution', 'escalated', 'resolved']).optional(),
        resolution: z.any().optional(),
      }).parse(request.body);

      const dispute = await prisma.dispute.findUnique({
        where: { id: request.params.id },
      });
      if (!dispute) throw new NotFound('Dispute not found');

      const data: Record<string, unknown> = {};
      if (body.status) data.status = body.status;
      if (body.resolution) data.resolution = body.resolution;
      if (body.status === 'resolved') data.resolvedAt = new Date();

      const updated = await prisma.dispute.update({
        where: { id: dispute.id },
        data,
      });

      return { dispute: normalizeDispute(updated as unknown as Record<string, unknown> | null) };
    },
  );

  /* Frontend-facing: mediator resolves a dispute */
  app.post<{ Params: { id: string } }>(
    '/api/admin/disputes/:id/resolve',
    { preHandler: [requireMediator] },
    async (request) => {
      const body = FrontendResolveSchema.parse(request.body);

      const dispute = await prisma.dispute.findUnique({
        where: { id: request.params.id },
        include: { order: { include: { seller: true } } },
      });
      if (!dispute) throw new NotFound('Dispute not found');

      const amount = dispute.order.priceNGN;
      const buyerShare =
        body.outcome === 'refund_buyer' ? 100
        : body.outcome === 'release_seller' ? 0
        : Math.min(100, Math.max(0, body.splitPct ?? 50));

      const buyerRefundNGN = Math.round((amount * buyerShare) / 100);
      const sellerReleaseNGN = amount - buyerRefundNGN;
      const nextStatus = body.outcome === 'refund_buyer' ? 'refunded' : 'released';

      const resolution: Record<string, unknown> = {
        outcome: body.outcome,
        buyerRefundNGN,
        sellerReleaseNGN,
        reasoning: body.rationale,
        mediator: 'SafeSale mediator',
        resolvedAt: new Date().toISOString(),
      };

      let transferTxRef: string | null = null;

      if (sellerReleaseNGN > 0) {
        const seller = dispute.order.seller;
        if (
          seller.bankAccountNumber &&
          seller.bankCode &&
          seller.bankAccountName
        ) {
          const transfer = await transferToBank({
            amount: sellerReleaseNGN,
            accountNumber: seller.bankAccountNumber,
            accountName: seller.bankAccountName,
            bankCode: seller.bankCode,
            merchantTxRef: `resolve_${dispute.id}_${Date.now()}`,
            narration: `SafeSale dispute resolution — seller share of order ${dispute.order.shortId}`,
          });
          transferTxRef = transfer.transactionId;
          resolution.transferTxRef = transferTxRef;
        }
      }

      const updated = await prisma.dispute.update({
        where: { id: dispute.id },
        data: {
          status: 'resolved',
          resolvedAt: new Date(),
          resolution: resolution as unknown as any,
        },
      });

      const orderUpdate: Record<string, unknown> = {
        status: nextStatus,
        ...(nextStatus === 'released' ? { releasedAt: new Date() } : { refundedAt: new Date() }),
      };
      if (transferTxRef) orderUpdate.nombaReference = transferTxRef;

      await prisma.order.update({
        where: { id: dispute.orderId },
        data: orderUpdate,
      });

      const updatedOrder = await prisma.order.findUnique({
        where: { id: dispute.orderId },
        include: { listing: true, seller: true },
      });

      return {
        order: normalizeOrder(updatedOrder as unknown as Record<string, unknown>),
        dispute: normalizeDispute(updated as unknown as Record<string, unknown> | null),
      };
    },
  );
};

export default disputesRoute;
