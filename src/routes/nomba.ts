import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { isUniqueViolation } from '../lib/errors.js';
import { verifyNombaWebhookSignature } from '../services/payments/nomba.js';
import { onOrderFunded } from '../services/notifications.js';
import { markFunded } from '../services/escrow.js';

interface NombaWebhook {
  event_type?: string;
  requestId?: string;
  data?: {
    transaction?: {
      aliasAccountReference?: string;
      transactionId?: string;
      transactionAmount?: number | string;
    };
  };
}

export default async function nombaRoutes(app: FastifyInstance) {
  app.post('/api/webhooks/nomba', async (request, reply) => {
    const payload = (request.body ?? {}) as NombaWebhook;
    const signature = String(request.headers['nomba-signature'] ?? request.headers['nomba-sig-value'] ?? '');
    const timestamp = String(request.headers['nomba-timestamp'] ?? '');

    if (!signature || !timestamp || !verifyNombaWebhookSignature(payload as Record<string, unknown>, signature, timestamp)) {
      logger.warn({ requestId: payload.requestId }, 'Rejected Nomba webhook: bad or missing signature');
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid webhook signature' } });
    }

    const requestId = payload.requestId;
    if (!requestId) {
      // Signed but malformed: acknowledge so Nomba doesn't retry forever.
      logger.warn('Nomba webhook without requestId — ignored');
      return { handled: false };
    }

    // Record the event once; replays of a processed event are no-ops.
    let event = await prisma.webhookEvent.findUnique({ where: { externalId: requestId } });
    if (!event) {
      try {
        event = await prisma.webhookEvent.create({
          data: {
            provider: 'nomba',
            externalId: requestId,
            payload: payload as Prisma.InputJsonValue,
            status: 'received',
          },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        event = await prisma.webhookEvent.findUniqueOrThrow({ where: { externalId: requestId } });
      }
    }
    if (event.status === 'processed') return { handled: true, event: 'duplicate' };

    await prisma.webhookEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 } } });

    try {
      const outcome = payload.event_type === 'payment_success' ? await handlePaymentSuccess(payload) : 'ignored';
      await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: 'processed' } });
      return { handled: true, event: outcome };
    } catch (err) {
      logger.error({ err, requestId }, 'Nomba webhook processing failed');
      await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: 'failed' } });
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Webhook processing failed' } });
    }
  });
}

async function handlePaymentSuccess(payload: NombaWebhook): Promise<string> {
  const tx = payload.data?.transaction ?? {};
  const reference = tx.aliasAccountReference;
  if (!reference) return 'missing_reference';

  const order = await prisma.order.findUnique({ where: { orderToken: reference } });
  if (!order) {
    logger.warn({ reference }, 'Nomba webhook: no order for account reference');
    return 'order_not_found';
  }

  const paidNGN = Number(tx.transactionAmount);
  if (!Number.isFinite(paidNGN) || paidNGN < order.priceNGN) {
    // Underpayment: leave the order unpaid and flag it for follow-up.
    logger.warn({ orderId: order.id, paidNGN, expected: order.priceNGN }, 'Nomba webhook: underpayment');
    await prisma.order.update({
      where: { id: order.id },
      data: { notes: `Underpaid: received ₦${tx.transactionAmount ?? '?'} of ₦${order.priceNGN}` },
    });
    return 'underpaid';
  }

  const funded = await markFunded(order.id, Math.round(paidNGN), tx.transactionId ?? null);
  if (!funded) return 'already_processed';

  logger.info({ orderId: order.id, shortId: order.shortId }, 'Order funded via Nomba webhook');
  await onOrderFunded(order.id);
  return 'funded';
}
