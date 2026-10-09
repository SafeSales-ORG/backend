import { afterAll, describe, expect, it } from 'vitest';
import { api, createSellerWithListing, getApp, placeFundedOrder, placeOrder, prisma } from './helpers.js';

afterAll(async () => {
  await prisma.$disconnect();
});

// 1x1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SVG = 'data:image/png;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');

describe('image uploads', () => {
  it('stores a seller image and serves it back', async () => {
    const { token } = await createSellerWithListing();
    const res = await api('POST', '/api/uploads', { token, body: { dataUrl: PNG } });
    expect(res.status).toBe(201);
    expect(res.body.contentType).toBe('image/png');
    expect(res.body.url).toMatch(/^http:\/\/localhost:3000\/uploads\/images\/\d{4}\/\d{2}\/[0-9a-f-]+\.png$/);

    const served = await (await getApp()).inject({ method: 'GET', url: new URL(res.body.url).pathname });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
  });

  it('rejects anonymous uploads', async () => {
    expect((await api('POST', '/api/uploads', { body: { dataUrl: PNG } })).status).toBe(401);
  });

  it('rejects files that are not really JPEG/PNG/WebP (e.g. SVG with script)', async () => {
    const { token } = await createSellerWithListing();
    const res = await api('POST', '/api/uploads', { token, body: { dataUrl: SVG } });
    expect(res.status).toBe(415);
  });

  it('lets a buyer upload evidence with a paid order token, not an unpaid one', async () => {
    const { listing } = await createSellerWithListing();
    const paid = await placeFundedOrder(listing.id);
    const ok = await api('POST', '/api/uploads', { headers: { 'x-buyer-token': paid.buyerToken }, body: { dataUrl: PNG } });
    expect(ok.status).toBe(201);

    const unpaid = await placeOrder(listing.id);
    const denied = await api('POST', '/api/uploads', {
      headers: { 'x-buyer-token': unpaid.body.buyerToken },
      body: { dataUrl: PNG },
    });
    expect(denied.status).toBe(401);
  });

  it('accepts uploaded image URLs on listings', async () => {
    const { token } = await createSellerWithListing();
    const up = await api('POST', '/api/uploads', { token, body: { dataUrl: PNG } });
    const created = await api('POST', '/api/listings', {
      token,
      body: {
        title: 'Uploaded photo listing',
        description: 'Listing that uses a stored image URL.',
        priceNGN: 5000,
        images: [{ url: up.body.url }],
        category: 'fashion',
      },
    });
    expect(created.status).toBe(201);
  });
});
