import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { paymentSimulationEnabled } from '../env.js';
import { prisma } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { NotFound } from '../lib/errors.js';
import { markFunded } from '../services/escrow.js';
import { onOrderFunded } from '../services/notifications.js';

const SimulatePaymentSchema = z.object({
  orderToken: z.string().min(8).max(128),
});

/**
 * Dev/staging only: mark an order paid without a real transfer.
 * Not registered at all unless PAYMENT_SIMULATION=true outside production.
 */
const devRoute: FastifyPluginAsync = async (app) => {
  if (!paymentSimulationEnabled) return;

  app.post('/api/dev/simulate-payment', async (request) => {
    const { orderToken } = SimulatePaymentSchema.parse(request.body);
    const order = await prisma.order.findFirst({
      where: { OR: [{ buyerToken: orderToken }, { orderToken }] },
    });
    if (!order) throw new NotFound('Order not found');

    const funded = await markFunded(order.id, order.priceNGN, `sim_${order.orderToken}`);
    if (funded) {
      logger.info({ orderId: order.id, shortId: order.shortId }, 'Payment simulated');
      await onOrderFunded(order.id);
    }
    return { ok: true, funded, simulatedAmountNGN: order.priceNGN };
  });
};

export default devRoute;
