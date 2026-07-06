import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { BadRequest, NotFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { bankAccountLookup } from '../services/nomba.js';

const CreateSellerSchema = z.object({
  name: z.string().min(2).max(140),
  handle: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-z0-9_]+$/),
  avatar: z.string().url().optional(),
  bio: z.string().max(1000).optional(),
  bankCode: z.string().min(3).max(10),
  bankAccountNumber: z.string().regex(/^\d{10}$/),
  delivery: z.string().max(140).optional(),
});

const UpdateSellerSchema = z.object({
  name: z.string().min(2).max(140).optional(),
  avatar: z.string().url().optional(),
  bio: z.string().max(1000).optional(),
  bankCode: z.string().min(3).max(10).optional(),
  bankAccountNumber: z.string().regex(/^\d{10}$/).optional(),
  delivery: z.string().max(140).optional(),
});

const sellersRoute: FastifyPluginAsync = async (app) => {
  app.post('/api/sellers', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = CreateSellerSchema.parse(request.body);

    const existing = await prisma.seller.findFirst({
      where: {
        OR: [
          { userId: request.user!.sub },
          { handle: body.handle },
        ],
      },
    });
    if (existing) {
      if (existing.userId === request.user!.sub) {
        throw new BadRequest('You already have a seller profile');
      }
      throw new BadRequest('That handle is taken');
    }

    const user = await prisma.user.findUnique({
      where: { id: request.user!.sub },
    });
    if (!user) throw new BadRequest('User not found');

    const account = await bankAccountLookup({
      accountNumber: body.bankAccountNumber,
      bankCode: body.bankCode,
    });

    const seller = await prisma.seller.create({
      data: {
        userId: request.user!.sub,
        npub: user.nostrNpub ?? `npub_${request.user!.sub.slice(0, 16)}`,
        name: body.name,
        handle: body.handle,
        avatar: body.avatar,
        bio: body.bio,
        bankCode: body.bankCode,
        bankAccountNumber: body.bankAccountNumber,
        bankAccountName: account.accountName,
        delivery: body.delivery,
      },
    });

    reply.code(201);
    return { seller };
  });

  app.get('/api/sellers/:handle', async (request) => {
    const { handle } = request.params as { handle: string };

    const seller = await prisma.seller.findUnique({
      where: { handle },
      select: {
        id: true,
        handle: true,
        name: true,
        avatar: true,
        bio: true,
        delivery: true,
        npub: true,
        createdAt: true,
      },
    });
    if (!seller) throw new NotFound('Seller not found');

    return { seller };
  });

  app.put('/api/sellers', { preHandler: [requireAuth] }, async (request) => {
    const body = UpdateSellerSchema.parse(request.body);

    const seller = await prisma.seller.findUnique({ where: { userId: request.user!.sub } });
    if (!seller) throw new NotFound('Seller profile not found');

    if (body.bankCode || body.bankAccountNumber) {
      const bankCode = body.bankCode ?? seller.bankCode;
      const bankAccountNumber = body.bankAccountNumber ?? seller.bankAccountNumber;

      const account = await bankAccountLookup({ accountNumber: bankAccountNumber, bankCode });

      const updated = await prisma.seller.update({
        where: { id: seller.id },
        data: {
          ...body,
          bankCode,
          bankAccountNumber,
          bankAccountName: account.accountName,
        },
      });

      return { seller: updated };
    }

    const updated = await prisma.seller.update({
      where: { id: seller.id },
      data: body,
    });

    return { seller: updated };
  });
};

export default sellersRoute;
