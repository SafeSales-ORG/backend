import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { BadRequest } from '../lib/errors.js';
import { verifyWebhookSignature } from '../services/nomba.js';

export default async function nombaRoutes(app: FastifyInstance) {
  app.post('/api/webhooks/nomba', async (request, reply) => {
    const rawBody = JSON.stringify(request.body);
    const headers = request.headers;

    const signature = (headers['nomba-signature'] as string) || (headers['nomba-sig-value'] as string) || '';
    const timestamp = (headers['nomba-timestamp'] as string) || '';

    if (!signature || !timestamp) {
      logger.warn({ headers: request.headers }, 'Nomba webhook missing signature headers');
      return reply.status(400).send({ error: 'Missing signature headers' });
    }

    const isValid = verifyWebhookSignature(rawBody, signature, timestamp);
    if (!isValid) {
      logger.warn({ body: request.body }, 'Nomba webhook signature mismatch');
      return reply.status(401).send({ error: 'Invalid webhook signature' });
    }

    const payload = request.body as {
      event_type: string;
      requestId?: string;
      data?: {
        transaction?: {
          aliasAccountReference?: string;
          transactionId?: string;
          transactionAmount?: number;
          type?: string;
        };
      };
    };

    const eventType = payload.event_type;
    const requestId = payload.requestId || '';
    const txData = payload.data?.transaction || {};

    if (!requestId) {
      throw new BadRequest('Webhook missing requestId');
    }

    const existing = await prisma.webhookEvent.findUnique({
      where: { externalId: requestId },
    });

    if (existing) {
      if (existing.status === 'processed') {
        return reply.send({ handled: true, event: 'duplicate' });
      }
      if (existing.status === 'failed') {
        await prisma.webhookEvent.update({
          where: { id: existing.id },
          data: { status: 'received', attempts: { increment: 1 } },
        });
      }
    } else {
      await prisma.webhookEvent.create({
        data: {
          provider: 'nomba',
          externalId: requestId,
          payload: request.body as Prisma.InputJsonValue,
          status: 'received',
        },
      });
    }

    try {
      if (eventType === 'payment_success') {
        const accountRef = txData.aliasAccountReference;
        const nombaTxId = txData.transactionId;
        const amountPaid = txData.transactionAmount;

        if (!accountRef) {
          throw new BadRequest('Webhook missing aliasAccountReference');
        }

        const order = await prisma.order.findFirst({
          where: { orderToken: accountRef },
        });

        if (!order) {
          logger.warn({ accountRef }, 'Nomba webhook: order not found for account ref');
          return reply.send({ handled: true, event: 'order_not_found' });
        }

        if (order.status !== 'pending_payment') {
          logger.info({ orderId: order.id, status: order.status }, 'Nomba webhook: order already processed');
          return reply.send({ handled: true, event: 'already_processed' });
        }

        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: 'funded',
            nombaReference: nombaTxId,
            notes: `Paid via Nomba: ₦${amountPaid}`,
          },
        });

        logger.info({ orderId: order.id, shortId: order.shortId }, 'Order funded via Nomba webhook');
      }

      await prisma.webhookEvent.updateMany({
        where: { externalId: requestId },
        data: { status: 'processed' },
      });

      return reply.send({ handled: true, event: eventType });
    } catch (err) {
      logger.error({ err, requestId }, 'Nomba webhook processing failed');

      await prisma.webhookEvent.updateMany({
        where: { externalId: requestId },
        data: { status: 'failed' },
      });

      return reply.status(500).send({ error: 'Webhook processing failed' });
    }
  });
}
