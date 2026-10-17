import { describe, expect, it } from 'vitest';
import { api, createSellerWithListing, placeFundedOrder } from './helpers.js';

async function mediatorToken() {
  const res = await api('POST', '/api/auth/login', {
    body: { email: 'mediator@safesale.test', password: 'mediator-test-password' },
  });
  return res.body.token as string;
}

async function openCase() {
  const { listing, token: sellerToken } = await createSellerWithListing({ priceNGN: 10_000 });
  const order = await placeFundedOrder(listing.id);
  const opened = await api('POST', `/api/orders/${order.buyerToken}/dispute`, {
    body: { reason: 'Wrong colour', summary: 'It is blue, not green', openedBy: 'buyer' },
  });
  expect(opened.status).toBe(201);
  return { sellerToken, order, disputeId: opened.body.dispute.id as string };
}

describe('dispute case thread', () => {
  it('opens with a system note and the buyer statement, visible to all three parties', async () => {
    const { sellerToken, order, disputeId } = await openCase();
    const mediator = await mediatorToken();

    const asBuyer = await api('GET', `/api/disputes/${disputeId}/thread`, { headers: { 'x-buyer-token': order.buyerToken } });
    expect(asBuyer.status).toBe(200);
    expect(asBuyer.body.viewer).toBe('buyer');
    expect(asBuyer.body.messages.map((m: { authorRole: string }) => m.authorRole)).toEqual(['system', 'buyer']);
    expect(asBuyer.body.messages[1].content).toContain('It is blue, not green');
    expect(asBuyer.body.waitingOn).toEqual(['mediator']);

    const asSeller = await api('GET', `/api/disputes/${disputeId}/thread`, { token: sellerToken });
    expect(asSeller.body.viewer).toBe('seller');
    const asMediator = await api('GET', `/api/disputes/${disputeId}/thread`, { token: mediator });
    expect(asMediator.body.viewer).toBe('mediator');
  });

  it('keeps outsiders out', async () => {
    const { order, disputeId } = await openCase();
    const other = await createSellerWithListing();
    expect((await api('GET', `/api/disputes/${disputeId}/thread`)).status).toBe(401);
    expect((await api('GET', `/api/disputes/${disputeId}/thread`, { token: other.token })).status).toBe(403);
    // The shared order reference is not the buyer's secret.
    expect((await api('GET', `/api/disputes/${disputeId}/thread`, { headers: { 'x-buyer-token': order.orderToken } })).status).toBe(401);
    // A seller session in the same browser doesn't hijack the buyer's link.
    const seller = await api('GET', `/api/disputes/${disputeId}/thread`, {
      token: other.token,
      headers: { 'x-buyer-token': order.buyerToken },
    });
    expect(seller.body.viewer).toBe('buyer');
  });

  it('tracks whose turn it is when the mediator asks for information', async () => {
    const { sellerToken, order, disputeId } = await openCase();
    const mediator = await mediatorToken();
    const buyer = { 'x-buyer-token': order.buyerToken };

    const ask = await api('POST', `/api/disputes/${disputeId}/thread`, {
      token: mediator,
      body: { content: 'Please both send photos of the item and the label.', requestFrom: 'both' },
    });
    expect(ask.status).toBe(201);
    let thread = await api('GET', `/api/disputes/${disputeId}/thread`, { headers: buyer });
    expect(thread.body.dispute.status).toBe('evidence_requested');
    expect(thread.body.dispute.evidenceDueAt).not.toBeNull();
    expect(thread.body.waitingOn).toEqual(['buyer', 'seller']);

    const photo = 'https://example.com/label.jpg';
    await api('POST', `/api/disputes/${disputeId}/thread`, { headers: buyer, body: { content: 'Here it is', attachments: [photo] } });
    thread = await api('GET', `/api/disputes/${disputeId}/thread`, { headers: buyer });
    expect(thread.body.waitingOn).toEqual(['seller']);

    await api('POST', `/api/disputes/${disputeId}/thread`, { token: sellerToken, body: { content: 'Sent green, see receipt' } });
    thread = await api('GET', `/api/disputes/${disputeId}/thread`, { headers: buyer });
    expect(thread.body.waitingOn).toEqual(['mediator']);
    expect(thread.body.dispute.status).toBe('mediating');
    expect(thread.body.dispute.evidence.map((e: { by: string; url: string }) => [e.by, e.url])).toEqual([['buyer', photo]]);

    // Only the mediator can ask for information.
    await api('POST', `/api/disputes/${disputeId}/thread`, { headers: buyer, body: { content: 'Seller, reply', requestFrom: 'seller' } });
    thread = await api('GET', `/api/disputes/${disputeId}/thread`, { headers: buyer });
    expect(thread.body.messages.at(-1).requestFrom).toBeNull();
    expect(thread.body.waitingOn).toEqual(['mediator']);
  });

  it('records the decision, shows the split on the order, and closes the thread', async () => {
    const { sellerToken, order, disputeId } = await openCase();
    const mediator = await mediatorToken();
    const resolved = await api('POST', `/api/admin/disputes/${disputeId}/resolve`, {
      token: mediator,
      body: { outcome: 'split', splitPct: 40, rationale: 'Both partly right.' },
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.order.settlement).toMatchObject({ outcome: 'split', buyerRefundNGN: 4_000 });

    const view = await api('GET', `/api/orders/${order.buyerToken}`);
    expect(view.body.order.settlement.buyerRefundNGN).toBe(4_000);
    expect(view.body.order.settlement.sellerReleaseNGN).toBeLessThanOrEqual(6_000);

    const thread = await api('GET', `/api/disputes/${disputeId}/thread`, { token: sellerToken });
    expect(thread.body.waitingOn).toEqual([]);
    expect(thread.body.messages.slice(-2).map((m: { authorRole: string }) => m.authorRole)).toEqual(['mediator', 'system']);
    expect(thread.body.messages.at(-1).content).toContain('split the money');

    const late = await api('POST', `/api/disputes/${disputeId}/thread`, { token: sellerToken, body: { content: 'Wait' } });
    expect(late.status).toBe(409);
  });

  it('shows the mediator queue whose turn it is', async () => {
    const { disputeId } = await openCase();
    const mediator = await mediatorToken();
    const queue = await api('GET', '/api/admin/disputes', { token: mediator });
    const row = queue.body.disputes.find((d: { id: string }) => d.id === disputeId);
    expect(row.thread).toMatchObject({ count: 1, lastFrom: 'buyer', waitingOn: ['mediator'] });
  });
});
