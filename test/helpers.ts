import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/client.js';

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  app ??= await buildApp();
  return app;
}

export async function api(
  method: InjectOptions['method'],
  url: string,
  opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
) {
  const res = await (await getApp()).inject({
    method,
    url,
    payload: opts.body as InjectOptions['payload'],
    headers: {
      ...(opts.token && { authorization: `Bearer ${opts.token}` }),
      ...opts.headers,
    },
  });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

let counter = 0;

/** Register a user and give them a seller profile + one listing. */
export async function createSellerWithListing(listing: { priceNGN?: number; inStock?: number; deliveryFee?: number } = {}) {
  const n = ++counter;
  const email = `seller${n}-${Date.now()}@example.com`;
  const reg = await api('POST', '/api/auth/register', { body: { email, password: 'password123' } });
  const token: string = reg.body.token;

  const seller = await api('POST', '/api/sellers', {
    token,
    body: {
      name: `Shop ${n}`,
      handle: `shop${n}_${Date.now()}`,
      bankCode: '058',
      bankAccountNumber: '0123456789',
    },
  });

  const created = await api('POST', '/api/listings', {
    token,
    body: {
      title: 'Ankara two-piece',
      description: 'Hand-tailored ankara set, size M.',
      priceNGN: listing.priceNGN ?? 20_000,
      images: [{ url: 'https://example.com/a.jpg' }],
      category: 'fashion',
      inStock: listing.inStock ?? 5,
      deliveryFee: listing.deliveryFee ?? 0,
    },
  });

  return { token, seller: seller.body.seller, listing: created.body.listing };
}

export async function placeOrder(listingId: string) {
  const res = await api('POST', '/api/orders', {
    body: { listingId, deliveryAddress: '12 Allen Avenue, Ikeja', buyerName: 'Ada Buyer', buyerPhone: '08030000000' },
  });
  return res;
}

export async function placeFundedOrder(listingId: string) {
  const res = await placeOrder(listingId);
  await api('POST', '/api/dev/simulate-payment', { body: { orderToken: res.body.buyerToken } });
  return { orderToken: res.body.order.orderToken as string, buyerToken: res.body.buyerToken as string, id: res.body.order.id as string };
}

export { prisma };
