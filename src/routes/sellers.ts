import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { payments } from '../services/payments/index.js';
import { normalizeSeller } from '../lib/normalize.js';

const AvatarUrl = z.string().max(500_000).regex(/^(https:\/\/|data:image\/)/);

const CreateSellerSchema = z.object({
  name: z.string().trim().min(2).max(140),
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(30)
    .regex(/^[a-z0-9_]+$/),
  avatar: AvatarUrl.optional(),
  // The frontend sends `avatarUrl`.
  avatarUrl: AvatarUrl.optional(),
  bio: z.string().max(1000).optional(),
  bankCode: z.string().min(3).max(10),
  bankAccountNumber: z.string().regex(/^\d{10}$/),
  delivery: z.string().max(140).optional(),
});

const UpdateSellerSchema = z.object({
  name: z.string().trim().min(2).max(140).optional(),
  avatar: AvatarUrl.optional(),
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
        throw new Conflict('You already have a seller profile');
      }
      throw new Conflict('That handle is taken');
    }

    const user = await prisma.user.findUnique({
      where: { id: request.user!.sub },
    });
    if (!user) throw new NotFound('User not found');

    const account = await payments.resolveBankAccount({
      accountNumber: body.bankAccountNumber,
      bankCode: body.bankCode,
    });

    const seller = await prisma.seller.create({
      data: {
        userId: request.user!.sub,
        npub: user.nostrNpub ?? `ss_${user.id}`,
        name: body.name,
        handle: body.handle,
        avatar: body.avatar ?? body.avatarUrl,
        bio: body.bio,
        bankCode: body.bankCode,
        bankAccountNumber: body.bankAccountNumber,
        bankAccountName: account.accountName,
        delivery: body.delivery,
      },
    });

    reply.code(201);
    return { seller: normalizeSeller(seller) };
  });

  /** The signed-in seller's own profile, with their payout account (masked). */
  app.get('/api/sellers/me', { preHandler: [requireAuth] }, async (request) => {
    const seller = await prisma.seller.findUnique({ where: { userId: request.user!.sub } });
    if (!seller) throw new NotFound('Seller profile not found');
    return {
      seller: normalizeSeller(seller),
      payout: {
        bankCode: seller.bankCode,
        bankName: seller.bankName ?? null,
        accountName: seller.bankAccountName ?? null,
        accountNumberLast4: seller.bankAccountNumber.slice(-4),
      },
    };
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
        verified: true,
        createdAt: true,
      },
    });
    if (!seller) throw new NotFound('Seller not found');

    return { seller: normalizeSeller(seller) };
  });

  app.put('/api/sellers', { preHandler: [requireAuth] }, async (request) => {
    const body = UpdateSellerSchema.parse(request.body);

    const seller = await prisma.seller.findUnique({ where: { userId: request.user!.sub } });
    if (!seller) throw new NotFound('Seller profile not found');

    if (body.bankCode || body.bankAccountNumber) {
      const bankCode = body.bankCode ?? seller.bankCode;
      const bankAccountNumber = body.bankAccountNumber ?? seller.bankAccountNumber;

      const account = await payments.resolveBankAccount({ accountNumber: bankAccountNumber, bankCode });

      const updated = await prisma.seller.update({
        where: { id: seller.id },
        data: {
          ...body,
          bankCode,
          bankAccountNumber,
          bankAccountName: account.accountName,
        },
      });

      return { seller: normalizeSeller(updated) };
    }

    const updated = await prisma.seller.update({
      where: { id: seller.id },
      data: body,
    });

    return { seller: normalizeSeller(updated) };
  });
};

export default sellersRoute;
