import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { BadRequest, NotFound } from '../lib/errors.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { createVirtualAccount, transferToBank } from '../services/nomba.js';
import { normalizeOrder, normalizeSeller, normalizeListing, normalizeDispute } from '../lib/normalize.js';

const CreateOrderSchema = z.object({
  listingId: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  variant: z.string().max(60).optional(),
  deliveryAddress: z.string().min(5).max(500),
  buyerPhone: z.string().optional(),
  buyerEmail: z.string().email().optional(),
});

async function getOrderWithDispute(token: string) {
  const order = await prisma.order.findUnique({
    where: { orderToken: token },
    include: { listing: true, seller: true, dispute: true },
  });
  return order;
}

const ordersRoute: FastifyPluginAsync = async (app) => {
  app.post('/api/orders', { preHandler: [optionalAuth] }, async (request, reply) => {
    const body = CreateOrderSchema.parse(request.body);

    const listing = await prisma.listing.findUnique({
      where: { id: body.listingId },
      include: { seller: true },
    });
    if (!listing) throw new NotFound('Listing not found');
    if (!listing.active) throw new BadRequest('Listing is no longer active');
    if (listing.inStock < body.quantity) {
      throw new BadRequest('Not enough items in stock');
    }

    const shortId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const orderToken = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

    const totalAmount = listing.priceNGN * body.quantity;

    const va = await createVirtualAccount({
      accountRef: orderToken,
      accountName: `SafeSale-${shortId}`,
      expectedAmount: totalAmount,
    });

    const order = await prisma.order.create({
      data: {
        shortId,
        orderToken,
        listingId: listing.id,
        sellerId: listing.sellerId,
        buyerId: request.user?.sub ?? undefined,
        buyerName: 'Guest Buyer',
        buyerPhone: body.buyerPhone,
        buyerEmail: body.buyerEmail,
        deliveryAddress: body.deliveryAddress,
        quantity: body.quantity,
        variant: body.variant,
        priceNGN: totalAmount,
        accountNumber: va.accountNumber,
        accountName: va.accountName,
        bankName: va.bankName,
        nombaReference: va.accountRef,
        status: 'pending_payment',
      },
    });

    await prisma.listing.update({
      where: { id: listing.id },
      data: { inStock: { decrement: body.quantity } },
    });

    reply.code(201);
    return {
      order,
      payment: {
        accountName: order.accountName,
        accountNumber: order.accountNumber,
        bankName: order.bankName,
        amount: order.priceNGN,
      },
    };
  });

  app.get('/api/orders/:token', async (request) => {
    const { token } = request.params as { token: string };

    const order = await getOrderWithDispute(token);
    if (!order) throw new NotFound('Order not found');

    return {
      order: normalizeOrder(order as unknown as Record<string, unknown>),
      listing: normalizeListing(order.listing as unknown as Record<string, unknown>),
      seller: normalizeSeller(order.seller as unknown as Record<string, unknown>),
      dispute: normalizeDispute(order.dispute as unknown as Record<string, unknown> | null),
    };
  });

  app.get('/api/orders', { preHandler: [requireAuth] }, async (request) => {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    await prisma.order.deleteMany({
      where: {
        status: 'pending_payment',
        createdAt: { lt: cutoff },
      },
    });

    const seller = await prisma.seller.findUnique({ where: { userId: request.user!.sub } });
    if (!seller) throw new NotFound('Seller profile not found');

    const orders = await prisma.order.findMany({
      where: {
        sellerId: seller.id,
        createdAt: { gte: oneWeekAgo },
      },
      include: { listing: true, dispute: true },
      orderBy: { createdAt: 'desc' },
    });

    return {
      orders: orders.map((o) => ({
        ...normalizeOrder(o as unknown as Record<string, unknown>),
        listing: normalizeListing(o.listing as unknown as Record<string, unknown>),
        dispute: normalizeDispute((o as any).dispute ?? null),
      })),
    };
  });

  app.get<{ Params: { npub: string } }>('/api/orders/seller/:npub', async (request) => {
    const seller = await prisma.seller.findUnique({ where: { npub: request.params.npub } });
    if (!seller) throw new NotFound('Seller not found');

    const orders = await prisma.order.findMany({
      where: { sellerId: seller.id },
      include: {
        listing: true,
        dispute: {
          include: { messages: { orderBy: { createdAt: 'asc' } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      orders: orders.map((o) => ({
        ...normalizeOrder(o as unknown as Record<string, unknown>),
        listing: normalizeListing(o.listing as unknown as Record<string, unknown>),
        dispute: normalizeDispute((o as any).dispute ?? null),
      })),
      seller: normalizeSeller(seller as unknown as Record<string, unknown>),
    };
  });

  app.patch<{ Params: { token: string } }>(
    '/api/orders/:token/ship',
    { preHandler: [requireAuth] },
    async (request) => {
      const order = await prisma.order.findUnique({
        where: { orderToken: request.params.token },
        include: { seller: true },
      });
      if (!order) throw new NotFound('Order not found');
      if (order.status !== 'funded') throw new BadRequest('Order must be funded before shipping');
      if (order.seller.userId !== request.user!.sub) {
        throw new BadRequest('You are not the seller of this order');
      }

      const { trackingNumber, carrier } = request.body as {
        trackingNumber?: string;
        carrier?: string;
      };
      if (!trackingNumber) throw new BadRequest('trackingNumber is required');

      const updated = await prisma.order.update({
        where: { id: order.id },
        data: { status: 'shipped', trackingNumber, carrier, shippedAt: new Date() },
      });

      return { order: normalizeOrder(updated as unknown as Record<string, unknown>) };
    },
  );

  /* POST alias for ship — frontend calls POST, backend has PATCH */
  app.post<{ Params: { token: string } }>(
    '/api/orders/:token/ship',
    { preHandler: [requireAuth] },
    async (request) => {
      const order = await prisma.order.findUnique({
        where: { orderToken: request.params.token },
        include: { seller: true },
      });
      if (!order) throw new NotFound('Order not found');
      if (order.status !== 'funded') throw new BadRequest('Order must be funded before shipping');
      if (order.seller.userId !== request.user!.sub) {
        throw new BadRequest('You are not the seller of this order');
      }

      const { trackingNumber, carrier } = request.body as {
        trackingNumber?: string;
        carrier?: string;
      };
      if (!trackingNumber) throw new BadRequest('trackingNumber is required');

      const updated = await prisma.order.update({
        where: { id: order.id },
        data: { status: 'shipped', trackingNumber, carrier, shippedAt: new Date() },
      });

      return { order: normalizeOrder(updated as unknown as Record<string, unknown>) };
    },
  );

  app.post<{ Params: { token: string } }>(
    '/api/orders/:token/deliver',
    { preHandler: [requireAuth] },
    async (request) => {
      const order = await prisma.order.findUnique({
        where: { orderToken: request.params.token },
        include: { seller: true },
      });
      if (!order) throw new NotFound('Order not found');
      if (order.status !== 'shipped') throw new BadRequest('Order must be shipped first');

      const isBuyer = order.buyerId === request.user!.sub;
      const isSeller = order.seller.userId === request.user!.sub;
      if (!isBuyer && !isSeller) {
        throw new BadRequest('You are not a participant in this order');
      }

      const updated = await prisma.order.update({
        where: { id: order.id },
        data: { status: 'delivered', deliveredAt: new Date() },
      });

      return { order: normalizeOrder(updated as unknown as Record<string, unknown>) };
    },
  );

  app.post<{ Params: { token: string } }>(
    '/api/orders/:token/release',
    { preHandler: [requireAuth] },
    async (request) => {
      const order = await prisma.order.findUnique({
        where: { orderToken: request.params.token },
        include: { seller: true },
      });
      if (!order) throw new NotFound('Order not found');
      if (order.status !== 'shipped' && order.status !== 'delivered') {
        throw new BadRequest('Order must be shipped or delivered before release');
      }

      if (order.seller.userId !== request.user!.sub) {
        throw new BadRequest('You are not the seller of this order');
      }

      const transfer = await transferToBank({
        amount: order.priceNGN,
        bankCode: order.seller.bankCode,
        accountNumber: order.seller.bankAccountNumber,
        accountName: order.seller.bankAccountName ?? '',
        merchantTxRef: `rel_${order.orderToken}`,
      });

      const updated = await prisma.order.update({
        where: { id: order.id },
        data: { status: 'released', releasedAt: new Date(), nombaReference: transfer.transactionId },
      });

      return {
        order: normalizeOrder(updated as unknown as Record<string, unknown>),
        txRef: transfer.transactionId,
      };
    },
  );
};

export default ordersRoute;
