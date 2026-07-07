import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { BadRequest, NotFound, Forbidden } from '../lib/errors.js';
import { requireAuth, requireMediator } from '../middleware/auth.js';

const OpenDisputeSchema = z.object({
  orderToken: z.string().min(1),
  reason: z.string().min(10).max(2000),
  summary: z.string().min(10).max(500).optional(),
  isReturn: z.boolean().optional().default(false),
});

const AddMessageSchema = z.object({
  content: z.string().min(1).max(2000),
});

const ResolveDisputeSchema = z.object({
  status: z.enum(['direct_resolution', 'escalated', 'resolved']).optional(),
  resolution: z.any().optional(),
});

const disputesRoute: FastifyPluginAsync = async (app) => {
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
    return { dispute };
  });

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

  app.post<{ Params: { id: string } }>(
    '/api/disputes/:id/messages',
    { preHandler: [requireAuth] },
    async (request) => {
      const body = AddMessageSchema.parse(request.body);

      const dispute = await prisma.dispute.findUnique({
        where: { id: request.params.id },
        include: { order: { include: { seller: true } } },
      });
      if (!dispute) throw new NotFound('Dispute not found');

      const isParticipant =
        dispute.order.buyerId === request.user!.sub ||
        dispute.order.seller.userId === request.user!.sub ||
        request.user!.role === 'MEDIATOR';
      if (!isParticipant) throw new Forbidden('You are not a participant in this dispute');

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

      return { disputes };
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/mediator/disputes/:id',
    { preHandler: [requireMediator] },
    async (request) => {
      const body = ResolveDisputeSchema.parse(request.body);

      const dispute = await prisma.dispute.findUnique({
        where: { id: request.params.id },
        include: { order: true },
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

      return { dispute: updated };
    },
  );
};

export default disputesRoute;
