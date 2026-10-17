import { describe, expect, it } from 'vitest';
import { api, createSellerWithListing, placeFundedOrder } from './helpers.js';

async function mediatorToken() {
  const res = await api('POST', '/api/auth/login', {
    body: { email: 'mediator@safesale.test', password: 'mediator-test-password' },
  });
  return res.body.token as string;
}

describe('admin console', () => {
  it('is staff only', async () => {
    const { token } = await createSellerWithListing();
    for (const path of ['/api/admin/overview', '/api/admin/orders', '/api/admin/sellers', '/api/admin/refunds']) {
      expect((await api('GET', path)).status).toBe(401);
      expect((await api('GET', path, { token })).status).toBe(403);
    }
  });

  it('shows money held, orders and sellers without bank numbers', async () => {
    const { listing, seller } = await createSellerWithListing({ priceNGN: 12_000 });
    const order = await placeFundedOrder(listing.id);
    const admin = await mediatorToken();

    const overview = await api('GET', '/api/admin/overview', { token: admin });
    expect(overview.status).toBe(200);
    expect(overview.body.heldNGN).toBeGreaterThanOrEqual(12_000);
    expect(overview.body.recentOrders.some((o: { id: string }) => o.id === order.id)).toBe(true);

    const found = await api('GET', `/api/admin/orders?q=${encodeURIComponent(seller.handle)}`, { token: admin });
    expect(found.body.orders.map((o: { id: string }) => o.id)).toEqual([order.id]);
    expect(found.body.orders[0].seller.handle).toBe(seller.handle);

    const sellers = await api('GET', '/api/admin/sellers', { token: admin });
    const row = sellers.body.sellers.find((s: { id: string }) => s.id === seller.id);
    expect(row).toMatchObject({ accountNumberLast4: '6789', orders: 1, heldNGN: 12_000, paidOutNGN: 0 });
    expect(JSON.stringify(row)).not.toContain('0123456789');
  });

  it('lists refunds owed to buyers and records them once', async () => {
    const { listing } = await createSellerWithListing({ priceNGN: 10_000 });
    const order = await placeFundedOrder(listing.id);
    const opened = await api('POST', `/api/orders/${order.buyerToken}/dispute`, { body: { reason: 'Broken', openedBy: 'buyer' } });
    const admin = await mediatorToken();
    await api('POST', `/api/admin/disputes/${opened.body.dispute.id}/resolve`, {
      token: admin,
      body: { outcome: 'refund_buyer', rationale: 'Arrived broken, photos confirm it.' },
    });

    const refunds = await api('GET', '/api/admin/refunds', { token: admin });
    const refund = refunds.body.refunds.find((r: { order: { shortId: string } }) => r.order.shortId === opened.body.order.shortId);
    expect(refund).toMatchObject({ status: 'manual', amountNGN: 10_000 });

    const pay = () => api('POST', `/api/admin/refunds/${refund.id}/mark-paid`, { token: admin, body: { reference: 'GTB-TRF-889201' } });
    expect((await pay()).status).toBe(200);
    expect((await pay()).status).toBe(409);

    const thread = await api('GET', `/api/disputes/${opened.body.dispute.id}/thread`, { headers: { 'x-buyer-token': order.buyerToken } });
    expect(thread.body.messages.at(-1).content).toContain('sent the buyer');
  });
});
