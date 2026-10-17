import type { FastifyPluginAsync } from 'fastify';
import type { EscrowStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { Conflict } from '../lib/errors.js';
import { requireMediator } from '../middleware/auth.js';
import { normalizeOrder, settlementOf } from '../lib/normalize.js';

/** Money SafeSale is holding: paid but not yet released or refunded. */
const HELD: EscrowStatus[] = ['funded', 'shipped', 'delivered', 'disputed'];

const OrdersQuery = z.object({
  status: z.enum(['pending_payment', 'funded', 'shipped', 'delivered', 'released', 'disputed', 'refunded']).optional(),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const PayoutParams = z.object({ id: z.string().min(1).max(64) });
const MarkPaidSchema = z.object({ reference: z.string().trim().min(3).max(120) });

function adminOrder(o: Prisma.OrderGetPayload<{ include: { seller: true; listing: true; dispute: true } }>) {
  return {
    ...normalizeOrder(o),
    seller: { id: o.seller.id, name: o.seller.name, handle: o.seller.handle },
    listingTitle: o.listing.title,
    disputeId: o.dispute?.id ?? null,
  };
}

/**
 * The SafeSale admin console: everything happening on the platform, for
 * the staff account (role MEDIATOR). Read-only except for recording
 * refunds that were paid by hand.
 */
const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireMediator);

  app.get('/api/admin/overview', async () => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [byStatus, held, releasedWeek, sellers, newSellers, activeListings, openDisputes, refunds, failed, recent] =
      await Promise.all([
        prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.order.aggregate({ where: { status: { in: HELD } }, _sum: { priceNGN: true } }),
        prisma.payout.aggregate({
          where: { kind: 'SELLER_RELEASE', status: 'succeeded', createdAt: { gte: weekAgo } },
          _sum: { amountNGN: true },
        }),
        prisma.seller.count(),
        prisma.seller.count({ where: { createdAt: { gte: weekAgo } } }),
        prisma.listing.count({ where: { active: true, inStock: { gt: 0 } } }),
        prisma.dispute.count({ where: { status: { not: 'resolved' } } }),
        prisma.payout.aggregate({
          where: { kind: 'BUYER_REFUND', status: 'manual' },
          _sum: { amountNGN: true },
          _count: { _all: true },
        }),
        prisma.payout.count({ where: { status: 'failed' } }),
        prisma.order.findMany({
          include: { seller: true, listing: true, dispute: true },
          orderBy: { createdAt: 'desc' },
          take: 8,
        }),
      ]);

    const ordersByStatus = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
    return {
      heldNGN: held._sum.priceNGN ?? 0,
      paidOutWeekNGN: releasedWeek._sum.amountNGN ?? 0,
      ordersByStatus,
      totalOrders: byStatus.reduce((n, s) => n + s._count._all, 0),
      sellers,
      newSellersWeek: newSellers,
      activeListings,
      openDisputes,
      refundsToPay: { count: refunds._count._all, amountNGN: refunds._sum.amountNGN ?? 0 },
      failedPayouts: failed,
      recentOrders: recent.map(adminOrder),
    };
  });

  app.get('/api/admin/orders', async (request) => {
    const { status, q, limit } = OrdersQuery.parse(request.query);
    const search = q
      ? {
          OR: [
            { shortId: { contains: q, mode: 'insensitive' as const } },
            { buyerName: { contains: q, mode: 'insensitive' as const } },
            { seller: { name: { contains: q, mode: 'insensitive' as const } } },
            { seller: { handle: { contains: q, mode: 'insensitive' as const } } },
            { listing: { title: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {};
    const orders = await prisma.order.findMany({
      where: { ...(status && { status }), ...search },
      include: { seller: true, listing: true, dispute: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return { orders: orders.map(adminOrder) };
  });

  app.get('/api/admin/sellers', async () => {
    const sellers = await prisma.seller.findMany({
      include: {
        user: { select: { email: true } },
        _count: { select: { listings: true, orders: true } },
        orders: { select: { status: true, priceNGN: true, dispute: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return {
      sellers: sellers.map((s) => ({
        id: s.id,
        name: s.name,
        handle: s.handle,
        email: s.user.email,
        verified: s.verified,
        bankName: s.bankName,
        accountNumberLast4: s.bankAccountNumber.slice(-4),
        listings: s._count.listings,
        orders: s._count.orders,
        heldNGN: s.orders.filter((o) => HELD.includes(o.status)).reduce((n, o) => n + o.priceNGN, 0),
        // What the shop actually received: a split only pays its share.
        paidOutNGN: s.orders
          .filter((o) => o.status === 'released')
          .reduce((n, o) => n + (settlementOf(o.dispute)?.sellerReleaseNGN ?? o.priceNGN), 0),
        disputes: s.orders.filter((o) => o.status === 'disputed').length,
        createdAt: s.createdAt.toISOString(),
      })),
    };
  });

  /** Refunds owed to buyers (no buyer bank details on file, so paid by hand). */
  app.get('/api/admin/refunds', async () => {
    const payouts = await prisma.payout.findMany({
      where: { kind: 'BUYER_REFUND', status: { in: ['manual', 'failed', 'succeeded'] } },
      include: { order: { include: { seller: true, dispute: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return {
      refunds: payouts.map((p) => ({
        id: p.id,
        status: p.status,
        amountNGN: p.amountNGN,
        reference: p.providerRef,
        createdAt: p.createdAt.toISOString(),
        paidAt: p.status === 'succeeded' ? p.updatedAt.toISOString() : null,
        order: {
          shortId: p.order.shortId,
          orderToken: p.order.orderToken,
          buyerName: p.order.buyerName,
          buyerPhone: p.order.buyerPhone,
          buyerEmail: p.order.buyerEmail,
          sellerName: p.order.seller.name,
          disputeId: p.order.dispute?.id ?? null,
        },
      })),
    };
  });

  /** Record that a manual refund was sent (bank transfer reference for the audit trail). */
  app.post('/api/admin/refunds/:id/mark-paid', async (request) => {
    const { id } = PayoutParams.parse(request.params);
    const { reference } = MarkPaidSchema.parse(request.body);
    const res = await prisma.payout.updateMany({
      where: { id, kind: 'BUYER_REFUND', status: { in: ['manual', 'failed'] } },
      data: { status: 'succeeded', providerRef: reference, error: null },
    });
    if (res.count === 0) throw new Conflict('This refund was already recorded as paid');

    // Let the buyer and seller see it in the case chat.
    const payout = await prisma.payout.findUniqueOrThrow({ where: { id }, include: { order: { include: { dispute: true } } } });
    if (payout.order.dispute) {
      await prisma.disputeMessage.create({
        data: {
          disputeId: payout.order.dispute.id,
          authorRole: 'system',
          content: `SafeSale sent the buyer's refund of ₦${payout.amountNGN.toLocaleString('en-NG')}.`,
        },
      });
    }
    return { ok: true };
  });
};

export default adminRoutes;
