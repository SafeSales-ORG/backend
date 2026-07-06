import { prisma } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { transferToBank } from './nomba.js';

const AUTO_RELEASE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

async function releaseExpiredOrders(): Promise<void> {
  const now = new Date();

  const orders = await prisma.order.findMany({
    where: {
      status: 'shipped',
      autoReleaseAt: { lte: now },
    },
    include: { seller: true },
  });

  if (orders.length === 0) return;

  logger.info({ count: orders.length }, 'Auto-release cron: processing expired orders');

  for (const order of orders) {
    try {
      if (
        !order.seller.bankAccountNumber ||
        !order.seller.bankCode ||
        !order.seller.bankAccountName
      ) {
        logger.warn(
          { orderId: order.id },
          'Auto-release skipped: seller has no payout details',
        );
        continue;
      }

      const fee = Math.floor(order.priceNGN * 0.01);
      const vendorAmount = order.priceNGN - fee;
      const merchantTxRef = `auto-release-${order.id}-${Date.now()}`;

      const result = await transferToBank({
        amount: vendorAmount,
        accountNumber: order.seller.bankAccountNumber,
        accountName: order.seller.bankAccountName,
        bankCode: order.seller.bankCode,
        merchantTxRef,
        narration: `SafeSale auto-release order ${order.shortId}`,
      });

      const updated = await prisma.order.updateMany({
        where: { id: order.id, status: 'shipped' },
        data: {
          status: 'completed',
          releasedAt: new Date(),
          notes: `Auto-released. Nomba ref: ${result.transactionId}. Fee: ₦${fee}`,
        },
      });

      if (updated.count === 0) {
        logger.warn({ orderId: order.id }, 'Auto-release: order already processed by another instance');
        continue;
      }

      logger.info({ orderId: order.id, shortId: order.shortId, vendorAmount }, 'Auto-release completed');
    } catch (err) {
      logger.error(
        { orderId: order.id, err: err instanceof Error ? err.message : err },
        'Auto-release failed for order',
      );
    }
  }
}

export function startAutoReleaseCron(): NodeJS.Timeout {
  logger.info({ intervalMs: AUTO_RELEASE_CHECK_INTERVAL_MS }, 'Auto-release cron started');
  const handle = setInterval(releaseExpiredOrders, AUTO_RELEASE_CHECK_INTERVAL_MS);
  releaseExpiredOrders();
  return handle;
}

export function stopAutoReleaseCron(handle: NodeJS.Timeout): void {
  clearInterval(handle);
  logger.info('Auto-release cron stopped');
}
