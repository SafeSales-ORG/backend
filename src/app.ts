import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { HttpError, isUniqueViolation } from './lib/errors.js';

import authRoutes from './routes/auth.js';
import sellersRoutes from './routes/sellers.js';
import listingsRoutes from './routes/listings.js';
import ordersRoutes from './routes/orders.js';
import nombaRoutes from './routes/nomba.js';
import devRoutes from './routes/dev.js';
import disputesRoutes from './routes/disputes.js';
import uploadsRoutes from './routes/uploads.js';
import adminRoutes from './routes/admin.js';
import fastifyStatic from '@fastify/static';
import path from 'node:path';

// Listing images and dispute evidence are sent inline as compressed data URLs.
const BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: BODY_LIMIT_BYTES });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch {
      const err = new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
      done(err, undefined);
    }
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ error: error.toPayload() });
    }

    if (error instanceof ZodError) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: error.issues },
      });
    }

    if (isUniqueViolation(error)) {
      return reply.status(409).send({ error: { code: 'CONFLICT', message: 'That record already exists' } });
    }

    // Fastify's own errors (body too large, unsupported media type, rate limit…).
    const err = error as { statusCode?: number; code?: string; message?: string };
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({
        error: { code: err.code ?? 'BAD_REQUEST', message: err.message ?? 'Bad request' },
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

  // Global ceiling per IP; sensitive routes set tighter limits in their config.
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  await app.register(authRoutes);
  await app.register(sellersRoutes);
  await app.register(listingsRoutes);
  await app.register(ordersRoutes);
  await app.register(nombaRoutes);
  await app.register(devRoutes);
  await app.register(disputesRoutes);
  await app.register(uploadsRoutes);
  await app.register(adminRoutes);

  // Local storage only (development): serve uploaded files.
  if (env.STORAGE_PROVIDER === 'local') {
    await app.register(fastifyStatic, {
      root: path.resolve(env.STORAGE_LOCAL_DIR),
      prefix: '/uploads/',
      decorateReply: false,
      immutable: true,
      maxAge: '1y',
    });
  }

  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  return app;
}
