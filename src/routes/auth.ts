import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { register, login, findOrCreateGoogleUser } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { prisma } from '../db/client.js';
import { BadRequest } from '../lib/errors.js';

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const GoogleAuthSchema = z.object({
  email: z.string().email(),
  googleId: z.string().min(1),
});

export default async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/register', async (request, reply) => {
    const parsed = RegisterSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid request', parsed.error.issues);
    }

    const { email, password } = parsed.data;
    const result = await register(email, password);
    return reply.status(201).send(result);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid request', parsed.error.issues);
    }

    const { email, password } = parsed.data;
    const result = await login(email, password);
    return reply.send(result);
  });

  app.post('/api/auth/google', async (request, reply) => {
    const parsed = GoogleAuthSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid request', parsed.error.issues);
    }

    const { email, googleId } = parsed.data;
    const result = await findOrCreateGoogleUser(googleId, email);
    return reply.send(result);
  });

  app.get('/api/auth/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user!.sub },
      select: {
        id: true,
        email: true,
        authProvider: true,
        emailVerified: true,
        nostrNpub: true,
        createdAt: true,
        seller: {
          select: {
            id: true,
            handle: true,
            name: true,
            npub: true,
          },
        },
      },
    });

    if (!user) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'User not found' },
      });
    }

    return reply.send({ user });
  });
}
