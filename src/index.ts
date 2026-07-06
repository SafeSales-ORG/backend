import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { HttpError } from './lib/errors.js';
import { ZodError } from 'zod';

import authRoutes from './routes/auth.js';
import sellersRoutes from './routes/sellers.js';
import listingsRoutes from './routes/listings.js';
import ordersRoutes from './routes/orders.js';
import nombaRoutes from './routes/nomba.js';
import devRoutes from './routes/dev.js';
import { startAutoReleaseCron } from './services/scheduler.js';

const app = Fastify({
  logger: false,
  trustProxy: true,
});

app.setErrorHandler((error: unknown, _request, reply) => {
  if (error instanceof HttpError) {
    return reply.status(error.status).send({ error: error.toPayload() });
  }

  if (error instanceof ZodError) {
    return reply.status(422).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: error.issues,
      },
    });
  }

  const err = error as any;
  if (err.validation) {
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.validation,
      },
    });
  }

  logger.error({ err: error }, 'Unhandled error');
  return reply.status(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: env.NODE_ENV === 'production' ? 'Internal server error' : (err.message ?? 'Unknown error'),
    },
  });
});

async function start() {
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (env.FRONTEND_ORIGINS.includes(origin)) return cb(null, true);
      if (env.FRONTEND_ORIGIN_REGEXES.some((r) => r.test(origin))) return cb(null, true);
      logger.warn({ origin }, 'CORS blocked');
      return cb(null, false);
    },
    credentials: true,
  });

  await app.register(authRoutes);
  await app.register(sellersRoutes);
  await app.register(listingsRoutes);
  await app.register(ordersRoutes);
  await app.register(nombaRoutes);
  await app.register(devRoutes);

  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info({ port: env.PORT }, 'Server started');
    startAutoReleaseCron();
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();

export default app;
