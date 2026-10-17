import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { Conflict, Forbidden, NotFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { payments } from '../services/payments/index.js';
import { autoReleaseDate, releaseToSeller } from '../services/escrow.js';
import { normalizeOrder, normalizeSeller, normalizeListing, normalizeDispute } from '../lib/normalize.js';

const CreateOrderSchema = z.object({
  listingId: z.string().min(1).max(64),
  quantity: z.number().int().positive().max(100).default(1),
  variant: z.string().max(60).optional(),
  deliveryAddress: z.string().trim().min(5).max(500),
  buyerName: z.string().trim().min(2).max(120).optional(),
  buyerPhone: z.string().trim().min(7).max(20).optional(),
  buyerEmail: z.string().trim().email().max(254).optional(),
});

const ShipSchema = z.object({
  trackingNumber: z.string().trim().max(100).optional(),
  carrier: z.string().trim().max(60).optional(),
});

const TokenParams = z.object({ token: z.string().min(8).max(128) });

const SHORT_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomShortId(): string {
  const bytes = crypto.randomBytes(6);
  return 'SS-' + Array.from(bytes, (b) => SHORT_ID_ALPHABET[b % SHORT_ID_ALPHABET.length]).join('');
}

function randomToken(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Find an order by the buyer's secret, or by the shared order reference. */
async function findOrderByAnyToken(token: string) {
  return prisma.order.findFirst({
    where: { OR: [{ buyerToken: token }, { orderToken: token }] },
    include: { listing: true, seller: true, dispute: true },
  });
}

/** Buyer-only actions require the buyer's secret token. */
async function findOrderForBuyer(token: string) {
  const order = await prisma.order.findUnique({ where: { buyerToken: token } });
  if (!order) throw new NotFound('Order not found');
  return order;
}

async function findOrderForSeller(orderToken: string, userId: string) {
  const order = await prisma.order.findUnique({ where: { orderToken }, include: { seller: true } });
  if (!order) throw new NotFound('Order not found');
  if (order.seller.userId !== userId) throw new Forbidden('You are not the seller of this order');
  return order;
}

const ordersRoute: FastifyPluginAsync = async (app) => {
  app.post('/api/orders', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = CreateOrderSchema.parse(request.body);

    const listing = await prisma.listing.findUnique({ where: { id: body.listingId } });
    if (!listing || !listing.active) throw new NotFound('Listing not found');
    if (listing.inStock < body.quantity) throw new Conflict('Not enough items in stock');

    const deliveryFeeNGN = listing.deliveryFee ?? 0;
    const totalNGN = listing.priceNGN * body.quantity + deliveryFeeNGN;
    const shortId = randomShortId();
    const orderToken = randomToken(12);
    const buyerToken = randomToken(24);

    const payIn = await payments.createPayInAccount({
      reference: orderToken,
      accountName: `SafeSale ${shortId}`,
      amountNGN: totalNGN,
    });

    const order = await prisma.$transaction(async (tx) => {
      // Conditional decrement — two buyers can't both take the last item.
      const reserved = await tx.listing.updateMany({
        where: { id: listing.id, active: true, inStock: { gte: body.quantity } },
        data: { inStock: { decrement: body.quantity } },
      });
      if (reserved.count === 0) throw new Conflict('Not enough items in stock');

      return tx.order.create({
        data: {
          shortId,
          orderToken,
          buyerToken,
          listingId: listing.id,
          sellerId: listing.sellerId,
          buyerName: body.buyerName ?? 'Buyer',
          buyerPhone: body.buyerPhone,
          buyerEmail: body.buyerEmail,
          deliveryAddress: body.deliveryAddress,
          quantity: body.quantity,
          variant: body.variant,
          priceNGN: totalNGN,
          deliveryFeeNGN,
          accountNumber: payIn.accountNumber,
          accountName: payIn.accountName,
          bankName: payIn.bankName,
          paymentReference: payIn.reference,
        },
      });
    });

    reply.code(201);
    return {
      order: normalizeOrder(order),
      // The buyer's private link token. Only ever returned here and in the
      // buyer's email — never to the seller.
      buyerToken: order.buyerToken,
      payment: {
        accountName: payIn.accountName,
        accountNumber: payIn.accountNumber,
        bankName: payIn.bankName,
        amount: totalNGN,
      },
    };
  });

  app.get('/api/orders/:token', async (request) => {
    const { token } = TokenParams.parse(request.params);
    const order = await findOrderByAnyToken(token);
    if (!order) throw new NotFound('Order not found');

    return {
      order: normalizeOrder(order),
      listing: normalizeListing(order.listing),
      seller: normalizeSeller(order.seller),
      dispute: normalizeDispute(order.dispute),
    };
  });

  /** The signed-in seller's orders. */
  app.get('/api/orders', { preHandler: [requireAuth] }, async (request) => {
    const seller = await prisma.seller.findUnique({ where: { userId: request.user!.sub } });
    if (!seller) throw new NotFound('Seller profile not found');
    return { orders: await sellerOrders(seller.id), seller: normalizeSeller(seller) };
  });

  /** Legacy path used by the frontend — same data, must be the caller's own shop. */
  app.get('/api/orders/seller/:npub', { preHandler: [requireAuth] }, async (request) => {
    const { npub } = z.object({ npub: z.string().min(1).max(128) }).parse(request.params);
    const seller = await prisma.seller.findUnique({ where: { npub } });
    if (!seller) throw new NotFound('Seller not found');
    if (seller.userId !== request.user!.sub) throw new Forbidden('You can only view your own orders');
    return { orders: await sellerOrders(seller.id), seller: normalizeSeller(seller) };
  });

  const ship = async (request: { params: unknown; body: unknown; user?: { sub: string } }) => {
    const { token } = TokenParams.parse(request.params);
    const body = ShipSchema.parse(request.body ?? {});
    const order = await findOrderForSeller(token, request.user!.sub);

    const now = new Date();
    const res = await prisma.order.updateMany({
      where: { id: order.id, status: 'funded' },
      data: {
        status: 'shipped',
        trackingNumber: body.trackingNumber || null,
        carrier: body.carrier || null,
        shippedAt: now,
        autoReleaseAt: autoReleaseDate(now),
      },
    });
    if (res.count === 0) throw new Conflict(`Order can't be shipped while it is ${order.status}`);

    return { order: normalizeOrder(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })) };
  };
  app.patch('/api/orders/:token/ship', { preHandler: [requireAuth] }, ship);
  app.post('/api/orders/:token/ship', { preHandler: [requireAuth] }, ship);

  /** Buyer confirms the item arrived. */
  app.post('/api/orders/:token/deliver', async (request) => {
    const { token } = TokenParams.parse(request.params);
    const order = await findOrderForBuyer(token);

    const res = await prisma.order.updateMany({
      where: { id: order.id, status: 'shipped' },
      data: { status: 'delivered', deliveredAt: new Date() },
    });
    if (res.count === 0) throw new Conflict(`Order can't be marked delivered while it is ${order.status}`);

    return { order: normalizeOrder(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })) };
  });

  /** Buyer releases escrow to the seller. Only the buyer can do this. */
  app.post('/api/orders/:token/release', async (request) => {
    const { token } = TokenParams.parse(request.params);
    const order = await findOrderForBuyer(token);

    const payout = await releaseToSeller(order.id, ['funded', 'shipped', 'delivered']);
    return {
      order: normalizeOrder(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })),
      payoutStatus: payout.status,
    };
  });
};

async function sellerOrders(sellerId: string) {
  const orders = await prisma.order.findMany({
    where: { sellerId },
    include: { listing: true, dispute: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  return orders.map((o) => ({
    ...normalizeOrder(o),
    listing: normalizeListing(o.listing),
    dispute: normalizeDispute(o.dispute),
  }));
}

export default ordersRoute;
