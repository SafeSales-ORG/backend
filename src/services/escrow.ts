/**
 * Escrow state transitions that move money. Every function here follows
 * the same rule: claim the order with a conditional update (so exactly one
 * caller wins a race), record the payout row with a deterministic reference
 * in the same transaction, and only then call the payment provider.
 */
import type { EscrowStatus, Payout } from '@prisma/client';
import { prisma } from '../db/client.js';
import { env } from '../env.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { payments } from './payments/index.js';

const PAYOUT_RETRY_AFTER_MS = 2 * 60 * 1000;
const PAYOUT_MAX_ATTEMPTS = 10;

export function platformFee(amountNGN: number): number {
  return Math.floor((amountNGN * env.PLATFORM_FEE_BPS) / 10_000);
}

export function autoReleaseDate(from = new Date()): Date {
  return new Date(from.getTime() + env.AUTO_RELEASE_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Mark an unpaid order as funded. Returns false if it was already funded
 * (or isn't awaiting payment), so webhooks can be replayed safely.
 */
export async function markFunded(orderId: string, paidAmountNGN: number, reference: string | null): Promise<boolean> {
  const res = await prisma.order.updateMany({
    where: { id: orderId, status: 'pending_payment' },
    data: {
      status: 'funded',
      paidAmountNGN,
      paidAt: new Date(),
      ...(reference && { paymentReference: reference }),
    },
  });
  return res.count === 1;
}

/**
 * Release escrowed funds to the seller. `from` lists the statuses the
 * caller is allowed to release from. Throws Conflict if the order has
 * already moved on (released, disputed, refunded…).
 */
export async function releaseToSeller(orderId: string, from: EscrowStatus[]): Promise<Payout> {
  const payout = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFound('Order not found');

    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: { in: from } },
      data: { status: 'released', releasedAt: new Date(), autoReleaseAt: null },
    });
    if (claimed.count === 0) {
      throw new Conflict(`Order can't be released while it is ${order.status}`);
    }

    const fee = platformFee(order.priceNGN);
    return tx.payout.create({
      data: {
        orderId,
        kind: 'SELLER_RELEASE',
        amountNGN: order.priceNGN - fee,
        feeNGN: fee,
        reference: `ss_rel_${orderId}`,
      },
    });
  });

  return executePayout(payout.id);
}

export type DisputeOutcome = 'refund_buyer' | 'release_seller' | 'split';

/**
 * Resolve a dispute: settle the order and create the payouts. The seller's
 * share is transferred immediately; the buyer's share is recorded as a
 * `manual` refund because we don't hold buyer bank details yet.
 */
export async function resolveDispute(params: {
  disputeId: string;
  outcome: DisputeOutcome;
  buyerPercent: number;
  rationale: string;
}) {
  const { disputeId, outcome, rationale } = params;
  const buyerPercent =
    outcome === 'refund_buyer' ? 100 : outcome === 'release_seller' ? 0 : Math.min(100, Math.max(0, params.buyerPercent));

  const sellerPayout = await prisma.$transaction(async (tx) => {
    const dispute = await tx.dispute.findUnique({ where: { id: disputeId }, include: { order: true } });
    if (!dispute) throw new NotFound('Dispute not found');
    if (dispute.status === 'resolved') throw new Conflict('Dispute is already resolved');

    const order = dispute.order;
    const buyerRefundNGN = Math.round((order.priceNGN * buyerPercent) / 100);
    const sellerGrossNGN = order.priceNGN - buyerRefundNGN;
    const sellerFeeNGN = platformFee(sellerGrossNGN);
    const now = new Date();
    const nextStatus: EscrowStatus = sellerGrossNGN > 0 ? 'released' : 'refunded';

    const claimed = await tx.order.updateMany({
      where: { id: order.id, status: 'disputed' },
      data: {
        status: nextStatus,
        autoReleaseAt: null,
        ...(sellerGrossNGN > 0 && { releasedAt: now }),
        ...(buyerRefundNGN > 0 && { refundedAt: now }),
      },
    });
    if (claimed.count === 0) throw new Conflict(`Order can't be settled while it is ${order.status}`);

    await tx.dispute.update({
      where: { id: dispute.id },
      data: {
        status: 'resolved',
        resolvedAt: now,
        resolution: {
          outcome,
          buyerPercent,
          buyerRefundNGN,
          sellerReleaseNGN: sellerGrossNGN - sellerFeeNGN,
          feeNGN: sellerFeeNGN,
          reasoning: rationale,
          mediator: 'SafeSale mediator',
          resolvedAt: now.toISOString(),
        },
      },
    });

    if (buyerRefundNGN > 0) {
      await tx.payout.create({
        data: {
          orderId: order.id,
          kind: 'BUYER_REFUND',
          status: 'manual',
          amountNGN: buyerRefundNGN,
          reference: `ss_ref_${order.id}`,
          error: 'Buyer refund must be paid manually (no buyer bank details on file).',
        },
      });
    }

    if (sellerGrossNGN === 0) return null;
    return tx.payout.create({
      data: {
        orderId: order.id,
        kind: 'SELLER_RELEASE',
        amountNGN: sellerGrossNGN - sellerFeeNGN,
        feeNGN: sellerFeeNGN,
        reference: `ss_rel_${order.id}`,
      },
    });
  });

  if (sellerPayout) await executePayout(sellerPayout.id);
}

/**
 * Attempt the transfer for a pending seller payout. Safe to call more than
 * once: the attempt is claimed with an optimistic check on `attempts`, and
 * the provider receives the same reference every time.
 */
export async function executePayout(payoutId: string): Promise<Payout> {
  const payout = await prisma.payout.findUnique({
    where: { id: payoutId },
    include: { order: { include: { seller: true } } },
  });
  if (!payout) throw new NotFound('Payout not found');
  if (payout.status !== 'pending' || payout.kind !== 'SELLER_RELEASE') return payout;

  const claimed = await prisma.payout.updateMany({
    where: { id: payout.id, status: 'pending', attempts: payout.attempts },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return payout; // another worker is on it

  const { seller, shortId } = payout.order;
  if (!seller.bankAccountNumber || !seller.bankCode || !seller.bankAccountName) {
    return prisma.payout.update({
      where: { id: payout.id },
      data: { status: 'failed', error: 'Seller has no verified payout account' },
    });
  }

  const result = await payments.transfer({
    reference: payout.reference,
    amountNGN: payout.amountNGN,
    bankCode: seller.bankCode,
    accountNumber: seller.bankAccountNumber,
    accountName: seller.bankAccountName,
    narration: `SafeSale payout for order ${shortId}`,
  });

  if (result.status !== 'succeeded') {
    logger.warn({ payoutId: payout.id, status: result.status, message: result.message }, 'Payout not completed');
  }

  return prisma.payout.update({
    where: { id: payout.id },
    data: {
      status: result.status === 'succeeded' ? 'succeeded' : result.status === 'failed' ? 'failed' : 'pending',
      providerRef: result.providerRef ?? payout.providerRef,
      error: result.status === 'succeeded' ? null : (result.message ?? null),
    },
  });
}

/** Release orders whose buyer-inspection window has passed. */
export async function autoReleaseDueOrders(now = new Date()): Promise<number> {
  const due = await prisma.order.findMany({
    where: { status: { in: ['shipped', 'delivered'] }, autoReleaseAt: { lte: now } },
    select: { id: true },
  });

  let released = 0;
  for (const { id } of due) {
    try {
      await releaseToSeller(id, ['shipped', 'delivered']);
      released++;
    } catch (err) {
      if (!(err instanceof Conflict)) logger.error({ orderId: id, err }, 'Auto-release failed');
    }
  }
  return released;
}

/** Retry seller payouts whose outcome was unknown. */
export async function retryPendingPayouts(now = new Date()): Promise<void> {
  const stale = await prisma.payout.findMany({
    where: {
      kind: 'SELLER_RELEASE',
      status: 'pending',
      attempts: { lt: PAYOUT_MAX_ATTEMPTS },
      updatedAt: { lte: new Date(now.getTime() - PAYOUT_RETRY_AFTER_MS) },
    },
    select: { id: true },
  });
  for (const { id } of stale) {
    try {
      await executePayout(id);
    } catch (err) {
      logger.error({ payoutId: id, err }, 'Payout retry failed');
    }
  }
}
