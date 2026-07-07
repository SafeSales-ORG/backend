import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { BadRequest, NotFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';

const ImageSchema = z.object({
  url: z.string().url().optional(),
  seed: z.string().optional(),
  alt: z.string().max(200).optional(),
}).refine((v) => v.url || v.seed, 'Image must have a url or a seed');

const CreateListingSchema = z.object({
  title: z.string().min(3).max(140),
  description: z.string().min(10).max(2000),
  priceNGN: z.number().int().positive().max(50_000_000),
  images: z.array(ImageSchema).min(1).max(8),
  category: z.string().min(2).max(60),
  variants: z.array(z.string().max(60)).optional(),
  inStock: z.number().int().nonnegative().default(1),
  delivery: z.string().max(140).optional(),
  deliveryFee: z.number().int().nonnegative().optional(),
});

const UpdateListingSchema = z.object({
  title: z.string().min(3).max(140).optional(),
  description: z.string().min(10).max(2000).optional(),
  priceNGN: z.number().int().positive().max(50_000_000).optional(),
  images: z.array(ImageSchema).min(1).max(8).optional(),
  category: z.string().min(2).max(60).optional(),
  variants: z.array(z.string().max(60)).optional(),
  inStock: z.number().int().nonnegative().optional(),
  delivery: z.string().max(140).optional(),
  deliveryFee: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
});

const ListingsQuerySchema = z.object({
  seller: z.string().regex(/^npub1[0-9a-z]+$/).optional(),
  active: z.enum(['true', 'false']).optional(),
});

const listingsRoute: FastifyPluginAsync = async (app) => {
  app.post('/api/listings', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = CreateListingSchema.parse(request.body);

    const seller = await prisma.seller.findUnique({
      where: { userId: request.user!.sub },
    });
    if (!seller) throw new BadRequest('You must complete seller onboarding first');

    const listing = await prisma.listing.create({
      data: {
        sellerId: seller.id,
        title: body.title,
        description: body.description,
        priceNGN: body.priceNGN,
        images: body.images,
        category: body.category,
        variants: body.variants,
        inStock: body.inStock,
        delivery: body.delivery,
        deliveryFee: body.deliveryFee,
      },
    });

    reply.code(201);
    return { listing };
  });

  app.get<{ Params: { id: string } }>('/api/listings/:id', async (request) => {
    const listing = await prisma.listing.findUnique({
      where: { id: request.params.id },
      include: { seller: true },
    });
    if (!listing) throw new NotFound(`Listing ${request.params.id} not found`);

    return { listing, seller: listing.seller };
  });

  app.patch<{ Params: { id: string } }>(
    '/api/listings/:id',
    { preHandler: [requireAuth] },
    async (request) => {
      const body = UpdateListingSchema.parse(request.body);

      const listing = await prisma.listing.findUnique({ where: { id: request.params.id } });
      if (!listing) throw new NotFound('Listing not found');

      const seller = await prisma.seller.findUnique({ where: { userId: request.user!.sub } });
      if (!seller || listing.sellerId !== seller.id) {
        throw new BadRequest('You are not the owner of this listing');
      }

      const updated = await prisma.listing.update({
        where: { id: listing.id },
        data: body,
      });

      return { listing: updated };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/listings/:id',
    { preHandler: [requireAuth] },
    async (request) => {
      const listing = await prisma.listing.findUnique({ where: { id: request.params.id } });
      if (!listing) throw new NotFound('Listing not found');

      const seller = await prisma.seller.findUnique({ where: { userId: request.user!.sub } });
      if (!seller || listing.sellerId !== seller.id) {
        throw new BadRequest('You are not the owner of this listing');
      }

      await prisma.listing.update({
        where: { id: listing.id },
        data: { active: false },
      });

      return { ok: true };
    },
  );

  app.get('/api/listings', async (request) => {
    const query = ListingsQuerySchema.parse(request.query);

    if (!query.seller) {
      throw new BadRequest('?seller=<npub> query parameter is required');
    }

    const seller = await prisma.seller.findUnique({ where: { npub: query.seller } });
    if (!seller) throw new NotFound('Seller not found');

    const listings = await prisma.listing.findMany({
      where: {
        sellerId: seller.id,
        ...(query.active !== undefined && { active: query.active === 'true' }),
      },
      orderBy: { createdAt: 'desc' },
    });

    return { listings };
  });
};

export default listingsRoute;
