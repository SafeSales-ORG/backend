import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { register, login, googleLogin } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { prisma } from '../db/client.js';
import { NotFound } from '../lib/errors.js';
import { env } from '../env.js';

const RegisterSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
});

const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

const GoogleAuthSchema = z.object({
  accessToken: z.string().min(10).max(4096),
});

// Brute-force protection for credential endpoints.
const authRateLimit = { rateLimit: { max: env.AUTH_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } };

export default async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/register', { config: authRateLimit }, async (request, reply) => {
    const { email, password } = RegisterSchema.parse(request.body);
    return reply.status(201).send(await register(email, password));
  });

  app.post('/api/auth/login', { config: authRateLimit }, async (request) => {
    const { email, password } = LoginSchema.parse(request.body);
    return login(email, password);
  });

  app.post('/api/auth/google', { config: authRateLimit }, async (request) => {
    const { accessToken } = GoogleAuthSchema.parse(request.body);
    return googleLogin(accessToken);
  });

  app.get('/api/auth/me', { preHandler: [requireAuth] }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user!.sub },
      select: {
        id: true,
        email: true,
        role: true,
        authProvider: true,
        emailVerified: true,
        nostrNpub: true,
        createdAt: true,
        seller: { select: { id: true, handle: true, name: true, npub: true } },
      },
    });
    if (!user) throw new NotFound('User not found');
    return { user };
  });
}
