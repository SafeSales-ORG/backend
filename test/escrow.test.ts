import { afterAll, describe, expect, it } from 'vitest';
import { autoReleaseDueOrders } from '../src/services/escrow.js';
import { api, createSellerWithListing, placeFundedOrder, placeOrder, prisma } from './helpers.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('orders', () => {
  it('charges item + delivery fee and only gives the buyer token to the buyer', async () => {
    const { listing, token } = await createSellerWithListing({ priceNGN: 20_000, deliveryFee: 1_500 });
    const res = await placeOrder(listing.id);

    expect(res.status).toBe(201);
    expect(res.body.payment.amount).toBe(21_500);
    expect(res.body.order.itemNGN).toBe(20_000);
    expect(res.body.order.deliveryFee).toBe(1_500);
    expect(typeof res.body.buyerToken).toBe('string');

    const sellerView = await api('GET', '/api/orders', { token });
    expect(JSON.stringify(sellerView.body)).not.toContain(res.body.buyerToken);
  });

  it('never sells more than is in stock', async () => {
    const { listing } = await createSellerWithListing({ inStock: 1 });
    const results = await Promise.all([placeOrder(listing.id), placeOrder(listing.id), placeOrder(listing.id)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it('protects the seller order feed', async () => {
    const { seller } = await createSellerWithListing();
    const other = await createSellerWithListing();

    expect((await api('GET', `/api/orders/seller/${seller.npub}`)).status).toBe(401);
    expect((await api('GET', `/api/orders/seller/${seller.npub}`, { token: other.token })).status).toBe(403);
  });

  it('does not leak seller bank details on public listing pages', async () => {
    const { listing } = await createSellerWithListing();
    const res = await api('GET', `/api/listings/${listing.id}`);
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('0123456789');
    expect(raw).not.toContain('bankCode');
    expect(raw).not.toContain('userId');
  });
});

describe('listings', () => {
  it("returns the seller's own listings, including hidden ones, only to that seller", async () => {
    const { listing, token } = await createSellerWithListing();
    await api('DELETE', `/api/listings/${listing.id}`, { token }); // hides it

    const mine = await api('GET', '/api/listings/mine', { token });
    expect(mine.status).toBe(200);
    expect(mine.body.listings.map((l: { id: string; active: boolean }) => [l.id, l.active])).toEqual([[listing.id, false]]);
    expect(JSON.stringify(mine.body)).not.toContain('0123456789');

    expect((await api('GET', '/api/listings/mine')).status).toBe(401);
    const other = await createSellerWithListing();
    const theirs = await api('GET', '/api/listings/mine', { token: other.token });
    expect(theirs.body.listings.map((l: { id: string }) => l.id)).toEqual([other.listing.id]);
  });
});

describe('marketplace', () => {
  it('lists active in-stock listings across shops with public seller info only', async () => {
    const a = await createSellerWithListing();
    const b = await createSellerWithListing({ inStock: 0 });
    const res = await api('GET', '/api/listings?limit=100');
    expect(res.status).toBe(200);
    const ids = res.body.listings.map((l: { id: string }) => l.id);
    expect(ids).toContain(a.listing.id);
    expect(ids).not.toContain(b.listing.id); // sold out
    const mine = res.body.listings.find((l: { id: string }) => l.id === a.listing.id);
    expect(mine.seller.handle).toBe(a.seller.handle);
    expect(JSON.stringify(res.body)).not.toContain('0123456789');
  });
});

describe('seller profile', () => {
  it('returns the payout account to its owner with the number masked', async () => {
    const { token } = await createSellerWithListing();
    const me = await api('GET', '/api/sellers/me', { token });
    expect(me.status).toBe(200);
    expect(me.body.payout).toMatchObject({ bankCode: '058', accountNumberLast4: '6789' });
    expect(JSON.stringify(me.body)).not.toContain('0123456789');
    expect((await api('GET', '/api/sellers/me')).status).toBe(401);
  });
});

describe('escrow release', () => {
  it('does not let the seller release funds with the shared order reference', async () => {
    const { listing, token } = await createSellerWithListing();
    const order = await placeFundedOrder(listing.id);

    const res = await api('POST', `/api/orders/${order.orderToken}/release`, { token });
    expect(res.status).toBe(404);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('funded');
  });

  it('refuses to release an unpaid order', async () => {
    const { listing } = await createSellerWithListing();
    const res = await placeOrder(listing.id);
    const release = await api('POST', `/api/orders/${res.body.buyerToken}/release`);
    expect(release.status).toBe(409);
  });

  it('funds once even if the payment is reported twice', async () => {
    const { listing } = await createSellerWithListing();
    const res = await placeOrder(listing.id);
    const first = await api('POST', '/api/dev/simulate-payment', { body: { orderToken: res.body.buyerToken } });
    const second = await api('POST', '/api/dev/simulate-payment', { body: { orderToken: res.body.buyerToken } });
    expect(first.body.funded).toBe(true);
    expect(second.body.funded).toBe(false);
  });

  it('pays the seller exactly once when the buyer releases concurrently', async () => {
    const { listing, token } = await createSellerWithListing({ priceNGN: 10_000 });
    const order = await placeFundedOrder(listing.id);

    const shipped = await api('POST', `/api/orders/${order.orderToken}/ship`, { token, body: { trackingNumber: 'GIG-123' } });
    expect(shipped.status).toBe(200);
    expect(shipped.body.order.autoReleaseAt).not.toBeNull();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => api('POST', `/api/orders/${order.buyerToken}/release`)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);

    const payouts = await prisma.payout.findMany({ where: { orderId: order.id } });
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ kind: 'SELLER_RELEASE', status: 'succeeded', amountNGN: 9_850, feeNGN: 150 });
  });

  it('auto-releases after the inspection window', async () => {
    const { listing, token } = await createSellerWithListing();
    const order = await placeFundedOrder(listing.id);
    await api('POST', `/api/orders/${order.orderToken}/ship`, { token, body: {} });
    await prisma.order.update({ where: { id: order.id }, data: { autoReleaseAt: new Date(Date.now() - 1000) } });

    await autoReleaseDueOrders();
    await autoReleaseDueOrders();

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('released');
    expect(await prisma.payout.count({ where: { orderId: order.id } })).toBe(1);
  });
});

describe('disputes', () => {
  async function mediatorToken() {
    const res = await api('POST', '/api/auth/login', {
      body: { email: 'mediator@safesale.test', password: 'mediator-test-password' },
    });
    expect(res.status).toBe(200);
    return res.body.token as string;
  }

  it('lets a guest buyer dispute, pauses auto-release, and settles a split once', async () => {
    const { listing, token } = await createSellerWithListing({ priceNGN: 10_000 });
    const order = await placeFundedOrder(listing.id);
    await api('POST', `/api/orders/${order.orderToken}/ship`, { token, body: {} });

    const opened = await api('POST', `/api/orders/${order.buyerToken}/dispute`, {
      body: { reason: 'Item never arrived', openedBy: 'buyer' },
    });
    expect(opened.status).toBe(201);
    expect(opened.body.order.status).toBe('disputed');
    expect(opened.body.order.autoReleaseAt).toBeNull();

    const again = await api('POST', `/api/orders/${order.buyerToken}/dispute`, {
      body: { reason: 'Again', openedBy: 'buyer' },
    });
    expect(again.status).toBe(409);

    // Disputed funds can't be released by the buyer link either.
    expect((await api('POST', `/api/orders/${order.buyerToken}/release`)).status).toBe(409);

    const mediator = await mediatorToken();
    const disputeId = opened.body.dispute.id;
    const resolve = () =>
      api('POST', `/api/admin/disputes/${disputeId}/resolve`, {
        token: mediator,
        body: { outcome: 'split', splitPct: 30, rationale: 'Partial delivery' },
      });
    const [a, b] = await Promise.all([resolve(), resolve()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const payouts = await prisma.payout.findMany({ where: { orderId: order.id }, orderBy: { kind: 'asc' } });
    expect(payouts.map((p) => [p.kind, p.status, p.amountNGN])).toEqual([
      ['SELLER_RELEASE', 'succeeded', 6_895], // 7,000 − 1.5% fee
      ['BUYER_REFUND', 'manual', 3_000],
    ]);
  });

  it("keeps both parties' evidence and the seller's reply", async () => {
    const { listing, token } = await createSellerWithListing();
    const order = await placeFundedOrder(listing.id);

    const opened = await api('POST', `/api/orders/${order.buyerToken}/dispute`, {
      body: { reason: 'Wrong colour', openedBy: 'buyer', evidence: ['https://example.com/buyer.jpg'] },
    });
    const responded = await api('POST', `/api/disputes/${opened.body.dispute.id}/respond`, {
      token,
      body: { stance: 'counter', message: 'Colour matches the photos', evidence: ['https://example.com/seller.jpg'] },
    });

    expect(responded.status).toBe(200);
    expect(responded.body.dispute.sellerResponse).toBe('Colour matches the photos');
    expect(responded.body.dispute.evidence.map((e: { url: string; by: string }) => [e.by, e.url])).toEqual([
      ['buyer', 'https://example.com/buyer.jpg'],
      ['seller', 'https://example.com/seller.jpg'],
    ]);
  });

  it('keeps mediator routes closed to normal users', async () => {
    const { token } = await createSellerWithListing();
    expect((await api('GET', '/api/admin/disputes', { token })).status).toBe(403);
    expect((await api('GET', '/api/admin/disputes')).status).toBe(401);
  });

  it('rejects a wrong mediator password and blocks registering the mediator email', async () => {
    const bad = await api('POST', '/api/auth/login', { body: { email: 'mediator@safesale.test', password: 'nope-nope-nope' } });
    expect(bad.status).toBe(401);
    const reg = await api('POST', '/api/auth/register', { body: { email: 'mediator@safesale.test', password: 'password123' } });
    expect(reg.status).toBe(409);
  });
});
