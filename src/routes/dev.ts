import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../env.js';
import { prisma } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { NotFound } from '../lib/errors.js';

const SimulatePaymentSchema = z.object({
  orderToken: z.string().min(8).max(64),
  amountNGN: z.number().int().positive().optional(),
});

const devRoute: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (_request, reply) => {
    if (env.NODE_ENV === 'production' && !env.NOMBA_SIMULATION) {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
  });

  app.post('/api/dev/simulate-payment', async (request) => {
    const body = SimulatePaymentSchema.parse(request.body);

    const order = await prisma.order.findUnique({ where: { orderToken: body.orderToken } });
    if (!order) throw new NotFound('Order not found');

    const amount = body.amountNGN ?? order.priceNGN;

    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'funded',
        nombaReference: `sim_${Date.now()}`,
        notes: `Simulated payment: ₦${amount}`,
      },
    });

    logger.info({ orderId: order.id, shortId: order.shortId, amount }, 'Payment simulated');

    return { ok: true, simulatedAmountNGN: amount };
  });
};

export default devRoute;
