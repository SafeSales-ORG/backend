import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const EMAIL = `smoke_${Date.now()}@test.com`;
const PASSWORD = 'TestPass123!';
const HANDLE = `smoke_${Date.now().toString(36)}`;

let jwt = '';
let sellerNpub = '';
let listingId = '';
let orderToken = '';

let passed = 0;
let failed = 0;

async function request(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const hasBody = body !== undefined;

  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }

  return { status: res.status, ok: res.ok, data };
}

async function step(name: string, fn: () => Promise<{ ok: boolean; detail?: string }>) {
  try {
    const result = await fn();
    if (result.ok) {
      console.log(`  PASS  ${name}`);
      passed++;
    } else {
      console.log(`  FAIL  ${name}${result.detail ? `\n    ${result.detail}` : ''}`);
      failed++;
    }
  } catch (err) {
    console.log(`  FAIL  ${name} — ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

function r(res: { status: number; ok: boolean; data: unknown }): { ok: boolean; detail: string } {
  return { ok: res.ok, detail: `[${res.status}] ${JSON.stringify(res.data).slice(0, 300)}` };
}

async function main() {
  console.log(`\nSafeSale Smoke Test\n`);
  console.log(`Base URL: ${BASE}`);
  console.log(`Test email: ${EMAIL}`);
  console.log(`Test handle: ${HANDLE}\n`);

  // 1. Health check
  await step('GET /health', async () => {
    const res = await request('GET', '/health');
    if (!res.ok) return r(res);
    return { ok: res.ok && typeof res.data === 'object' && res.data !== null && 'status' in (res.data as object) };
  });

  // 2. Register
  await step('POST /api/auth/register', async () => {
    const res = await request('POST', '/api/auth/register', {
      email: EMAIL,
      password: PASSWORD,
      name: 'Smoke Tester',
    });
    if (!res.ok) return r(res);
    return { ok: res.status === 201 };
  });

  // 3. Login
  await step('POST /api/auth/login', async () => {
    const res = await request('POST', '/api/auth/login', {
      email: EMAIL,
      password: PASSWORD,
    });
    if (!res.ok || typeof res.data !== 'object' || res.data === null) return r(res);
    const d = res.data as Record<string, unknown>;
    const token = d.token || (d.data as Record<string, unknown> | undefined)?.token;
    if (typeof token !== 'string' || !token) return { ok: false, detail: 'No token in response' };
    jwt = token;
    return { ok: true };
  });

  // 4. Get me
  await step('GET /api/auth/me', async () => {
    const res = await request('GET', '/api/auth/me', undefined, jwt);
    return res.ok ? { ok: true } : r(res);
  });

  // 5. Create seller
  await step('POST /api/sellers', async () => {
    const res = await request('POST', '/api/sellers', {
      name: 'Smoke Seller',
      handle: HANDLE,
      bio: 'Temporary test seller',
      bankCode: '999',
      bankAccountNumber: '1234567890',
      delivery: 'Ships within 3-5 business days',
    }, jwt);
    if (!res.ok || typeof res.data !== 'object' || res.data === null) return r(res);
    const d = res.data as Record<string, unknown>;
    const seller = d.seller as Record<string, unknown> | undefined;
    if (!seller?.id) return { ok: false, detail: 'No seller in response' };
    if (seller?.npub) sellerNpub = seller.npub as string;
    return { ok: true };
  });

  // 6. Get seller by handle
  await step('GET /api/sellers/:handle', async () => {
    const res = await request('GET', `/api/sellers/${HANDLE}`);
    return res.ok ? { ok: true } : r(res);
  });

  // 7. Create listing
  await step('POST /api/listings', async () => {
    const res = await request('POST', '/api/listings', {
      title: 'Smoke Test Item',
      description: 'A temporary listing for smoke testing the full flow',
      priceNGN: 5000,
      images: [{ seed: 'smoke-test' }],
      category: 'Testing',
      inStock: 10,
      delivery: 'Free shipping',
      deliveryFee: 1000,
    }, jwt);
    if (!res.ok || typeof res.data !== 'object' || res.data === null) return r(res);
    const d = res.data as Record<string, unknown>;
    const listing = d.listing as Record<string, unknown> | undefined;
    if (!listing?.id) return { ok: false, detail: 'No listing id' };
    listingId = listing.id as string;
    return { ok: true };
  });

  // 8. Get listing by ID
  await step('GET /api/listings/:id', async () => {
    const res = await request('GET', `/api/listings/${listingId}`);
    return res.ok ? { ok: true } : r(res);
  });

  // 9. List listings by seller npub
  await step('GET /api/listings?seller=', async () => {
    const res = await request('GET', `/api/listings?seller=${sellerNpub}`);
    if (!res.ok) return r(res);
    const d = res.data as Record<string, unknown>;
    const listings = d.listings as unknown[];
    return { ok: Array.isArray(listings) && listings.length > 0 };
  });

  // 10. PATCH listing (edit)
  await step('PATCH /api/listings/:id', async () => {
    const res = await request('PATCH', `/api/listings/${listingId}`, { title: 'Updated Smoke Item' }, jwt);
    if (!res.ok) return r(res);
    const d = res.data as Record<string, unknown>;
    const listing = d.listing as Record<string, unknown> | undefined;
    return { ok: listing?.title === 'Updated Smoke Item' };
  });

  // 11. Create order
  await step('POST /api/orders', async () => {
    const res = await request('POST', '/api/orders', {
      listingId,
      quantity: 2,
      deliveryAddress: '123 Test Street, Lagos',
      buyerPhone: '+2348000000000',
      buyerEmail: 'buyer@test.com',
    });
    if (!res.ok || typeof res.data !== 'object' || res.data === null) return r(res);
    const d = res.data as Record<string, unknown>;
    const order = d.order as Record<string, unknown> | undefined;
    if (!order?.id || !order?.orderToken) return { ok: false, detail: 'Missing order id/token' };
    orderToken = order.orderToken as string;
    return { ok: order.status === 'pending_payment' };
  });

  // 12. Get order by token
  await step('GET /api/orders/:token', async () => {
    const res = await request('GET', `/api/orders/${orderToken}`);
    return res.ok ? { ok: true } : r(res);
  });

  // 13. Simulate payment
  await step('POST /api/dev/simulate-payment', async () => {
    const res = await request('POST', '/api/dev/simulate-payment', {
      orderToken,
      amountNGN: 10000,
    });
    return res.ok ? { ok: true } : r(res);
  });

  await sleep(500);

  // 14. Get seller orders (verify funded)
  await step('GET /api/orders (seller, verify funded)', async () => {
    const res = await request('GET', '/api/orders', undefined, jwt);
    if (!res.ok) return r(res);
    const d = res.data as Record<string, unknown>;
    const orders = d.orders as unknown[];
    if (!Array.isArray(orders) || orders.length === 0) return { ok: false, detail: 'No orders found' };
    return { ok: (orders[0] as Record<string, unknown>).status === 'funded' };
  });

  // 15. Seller dashboard by npub
  await step('GET /api/orders/seller/:npub', async () => {
    const res = await request('GET', `/api/orders/seller/${sellerNpub}`);
    if (!res.ok) return r(res);
    const d = res.data as Record<string, unknown>;
    const orders = d.orders as unknown[];
    return { ok: Array.isArray(orders) && orders.length > 0 };
  });

  // 16. Ship order
  await step('PATCH /api/orders/:token/ship', async () => {
    const res = await request('PATCH', `/api/orders/${orderToken}/ship`, {
      trackingNumber: 'SMOKE123456',
      carrier: 'Test Courier',
    }, jwt);
    if (!res.ok) return r(res);
    const d = res.data as Record<string, unknown>;
    const order = d.order as Record<string, unknown> | undefined;
    return { ok: order?.status === 'shipped' };
  });

  // 17. Deliver order
  await step('POST /api/orders/:token/deliver', async () => {
    const res = await request('POST', `/api/orders/${orderToken}/deliver`, undefined, jwt);
    if (!res.ok) return r(res);
    const d = res.data as Record<string, unknown>;
    const order = d.order as Record<string, unknown> | undefined;
    return { ok: order?.status === 'delivered' };
  });

  // 18. Release funds
  await step('POST /api/orders/:token/release', async () => {
    const res = await request('POST', `/api/orders/${orderToken}/release`, undefined, jwt);
    return res.ok ? { ok: true } : r(res);
  });

  // 19. Verify released
  await step('GET /api/orders/:token (verify released)', async () => {
    const res = await request('GET', `/api/orders/${orderToken}`);
    if (!res.ok) return r(res);
    const d = res.data as Record<string, unknown>;
    const order = d.order as Record<string, unknown> | undefined;
    return { ok: order?.status === 'released', detail: `status=${order?.status}` };
  });

  // 20. Delete listing (soft delete)
  await step('DELETE /api/listings/:id', async () => {
    const res = await request('DELETE', `/api/listings/${listingId}`, undefined, jwt);
    return res.ok ? { ok: true } : r(res);
  });

  // 21. Mediator login
  await step('POST /api/auth/mediator/login', async () => {
    const res = await request('POST', '/api/auth/mediator/login', {
      email: 'mediator@safesale.app',
      password: 'mediator-dev-password',
    });
    if (!res.ok) return r(res);
    const d = res.data as Record<string, unknown>;
    return { ok: typeof d.token === 'string' && (d.user as Record<string, unknown>)?.role === 'MEDIATOR' };
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
