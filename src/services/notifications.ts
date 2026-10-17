import { prisma } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { sendBuyerOrderLinkEmail } from './email.js';

/** Side effects after an order is paid. Never throws — payment already succeeded. */
export async function onOrderFunded(orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { listing: true } });
    if (!order) return;
    await sendBuyerOrderLinkEmail({ order, listing: order.listing });
  } catch (err) {
    logger.warn({ orderId, err }, 'Post-payment notification failed (non-fatal)');
  }
}
