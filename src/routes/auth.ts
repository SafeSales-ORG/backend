import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { register, login, findOrCreateGoogleUser } from '../services/auth.js';
import type { JwtPayload } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { prisma } from '../db/client.js';
import { BadRequest, Unauthorized } from '../lib/errors.js';
import { env } from '../env.js';

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

  app.post('/api/auth/mediator/login', async (request, reply) => {
    const { email, password } = request.body as { email?: string; password?: string };
    if (!email || !password) throw new BadRequest('Email and password required');

    if (email !== env.MEDIATOR_EMAIL || password !== env.MEDIATOR_PASSWORD) {
      throw new Unauthorized('Invalid mediator credentials');
    }

    const payload: JwtPayload & { role: string } = {
      sub: 'mediator',
      email,
      nostrNpub: null,
      role: 'MEDIATOR',
    };
    const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: '24h' });

    return reply.send({ token, user: { email, role: 'MEDIATOR' } });
  });
}
