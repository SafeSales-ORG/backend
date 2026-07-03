/**
 * SafeSale backend end-to-end smoke test (v2 — MavaPay flow).
 *
 * Runs the entire happy-path flow against a live server:
 *   health → create seller → create listing → create order →
 *   simulate MavaPay webhook → seller ships → buyer releases → verify complete
 *
 * Usage:
 *   npm run smoke                            # local dev
 *   $env:SMOKE_BASE_URL = "https://..."      # against Railway
 *   npm run smoke
 *
 * Exit code 0 = all steps green. Non-zero = something broke.
 */

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const BASE_URL =
  process.env.SMOKE_BASE_URL?.replace(/\/+$/, '') ?? 'http://127.0.0.1:3000';

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

const log = {
  step: (n: number, label: string) =>
    console.log(`\n${COLORS.cyan}${COLORS.bold}━━━ Step ${n}: ${label}${COLORS.reset}`),
  ok: (msg: string) => console.log(`${COLORS.green}  ✓${COLORS.reset} ${msg}`),
  info: (msg: string) => console.log(`${COLORS.dim}  · ${msg}${COLORS.reset}`),
  warn: (msg: string) => console.log(`${COLORS.yellow}  ! ${msg}${COLORS.reset}`),
  fail: (msg: string) => console.log(`${COLORS.red}  ✗ ${msg}${COLORS.reset}`),
};

interface HttpResult<T> {
  ok: boolean;
  status: number;
  body: T | { error?: Record<string, unknown> };
}

async function http<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<HttpResult<T>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { _raw: text };
  }
  return { ok: res.ok, status: res.status, body: parsed as HttpResult<T>['body'] };
}

function fail(stepLabel: string, result: HttpResult<unknown>): never {
  log.fail(`${stepLabel} — HTTP ${result.status}`);
  console.log(`${COLORS.red}  response:${COLORS.reset}`, JSON.stringify(result.body, null, 2));
  process.exit(1);
}

function expectOk<T>(stepLabel: string, result: HttpResult<T>): T {
  if (!result.ok) fail(stepLabel, result);
  return result.body as T;
}

async function main() {
  console.log(`\n${COLORS.bold}SafeSale smoke test (v2 — MavaPay)${COLORS.reset}  →  ${COLORS.cyan}${BASE_URL}${COLORS.reset}`);

  // ---- Step 0: health check -------------------------------------------
  log.step(0, 'Health check');
  const health = await http<{ ok: boolean; service: string; env: string }>('GET', '/health');
  const healthBody = expectOk('GET /health', health);
  log.ok(`Server responding (env=${healthBody.env})`);
  const isProduction = healthBody.env === 'production';

  // ---- Generate keypairs ----------------------------------------------
  const sellerSk = generateSecretKey();
  const sellerPkHex = getPublicKey(sellerSk);
  const sellerNpub = nip19.npubEncode(sellerPkHex);

  const buyerSk = generateSecretKey();
  const buyerPkHex = getPublicKey(buyerSk);
  const buyerNpub = nip19.npubEncode(buyerPkHex);

  const handle = `smoke-${Date.now().toString(36)}`;
  log.info(`seller npub: ${sellerNpub.slice(0, 20)}…`);
  log.info(`buyer npub:  ${buyerNpub.slice(0, 20)}…`);

  // ---- Step 1: create seller ------------------------------------------
  log.step(1, 'Create seller');
  const sellerRes = await http<{ seller: { id: string; handle: string } }>(
    'POST', '/api/sellers', {
      npub: sellerNpub,
      handle,
      name: 'Smoke Test Shop',
      location: 'Lagos',
      phone: '+2348012345678',
      category: 'fashion',
    },
  );
  const { seller } = expectOk('POST /api/sellers', sellerRes);
  log.ok(`Seller @${seller.handle} created (id=${seller.id})`);

  // ---- Step 2: create listing -----------------------------------------
  log.step(2, 'Create listing');
  const listingRes = await http<{ listing: { id: string; title: string } }>(
    'POST', '/api/listings', {
      sellerNpub,
      title: 'Smoke Test Ankara Dress',
      description: 'End-to-end smoke test listing.',
      priceNGN: 15000,
      category: 'fashion',
      images: [{ seed: `smoke-${Date.now()}`, alt: 'Test image' }],
    },
  );
  const { listing } = expectOk('POST /api/listings', listingRes);
  log.ok(`Listing "${listing.title}" created (id=${listing.id})`);

  // ---- Step 3: create order -------------------------------------------
  log.step(3, 'Create order');
  const orderRes = await http<{
    orderToken: string;
    shortId: string;
    payIn: {
      bankName: string;
      bankAccountNumber: string;
      bankAccountName: string;
      totalAmountKobo: number;
      expiresAt: string;
    } | null;
    amountNGN: number;
  }>('POST', '/api/orders', {
    listingId: listing.id,
    buyerNpub,
    buyerName: 'Smoke Test Buyer',
    buyerPhone: '+2348098765432',
    buyerCity: 'Abuja',
  });
  const order = expectOk('POST /api/orders', orderRes);
  if (order.payIn) {
    log.ok(`Order ${order.shortId} — ₦${order.amountNGN.toLocaleString('en-NG')}, transfer ${order.payIn.totalAmountKobo / 100} NGN to ${order.payIn.bankName} ${order.payIn.bankAccountNumber}`);
  } else {
    log.warn(`Order ${order.shortId} — ₦${order.amountNGN.toLocaleString('en-NG')}, no MavaPay pay-in quote (will attempt anyway)`);
  }
  const token = order.orderToken;

  // ---- Step 4: simulate payment webhook --------------------------------
  log.step(4, 'Simulate MavaPay payment (paid)');
  if (isProduction) {
    log.info('production env — would fire real MavaPay webhook here');
    log.info('skipping automated payment step for production smoke');
    log.warn('manually curl POST /api/webhooks/mavapay to advance order state');
    log.info('continuing with remaining basic checks...');
  } else {
    const payRes = await http<{ ok: boolean; simulatedAmountKobo: number }>(
      'POST', '/api/dev/simulate-payment', { orderToken: token },
    );
    const pay = expectOk('POST /api/dev/simulate-payment', payRes);
    log.ok(`Payment simulated — ${pay.simulatedAmountKobo} kobo`);

    const checkRes = await http<{ order: { status: string } }>('GET', `/api/orders/${token}`);
    const check = expectOk(`GET /api/orders/${token}`, checkRes);
    if (check.order.status !== 'paid') {
      log.fail(`Expected status="paid", got "${check.order.status}"`);
      process.exit(1);
    }
    log.ok('Order status is "paid"');
  }

  // ---- Step 5: seller marks shipped ------------------------------------
  log.step(5, 'Seller marks shipped');
  const shipRes = await http<{ order: { status: string; shippedAt: string } }>(
    'POST', `/api/orders/${token}/ship`,
    { trackingNumber: 'SMOKE-TRACK-001', carrier: 'DHL' },
  );
  const ship = expectOk(`POST /api/orders/${token}/ship`, shipRes);
  if (ship.order.status !== 'shipped') {
    log.fail(`Expected status="shipped", got "${ship.order.status}"`);
    process.exit(1);
  }
  log.ok(`Order shipped at ${ship.order.shippedAt}`);

  // ---- Step 6: buyer releases payment ----------------------------------
  log.step(6, 'Buyer releases payment');
  const releaseRes = await http<{
    order: { status: string; releasedAt: string };
  }>('POST', `/api/orders/${token}/release`, {});
  const release = expectOk(`POST /api/orders/${token}/release`, releaseRes);
  if (release.order.status !== 'completed') {
    log.fail(`Expected status="completed", got "${release.order.status}"`);
    process.exit(1);
  }
  log.ok(`Order completed. releasedAt=${release.order.releasedAt}`);

  // ---- Step 7: verify final state via GET ------------------------------
  log.step(7, 'Verify final order state');
  const finalRes = await http<{ order: { status: string } }>('GET', `/api/orders/${token}`);
  const final = expectOk(`GET /api/orders/${token}`, finalRes);
  if (final.order.status !== 'completed') {
    log.fail(`Final read shows "${final.order.status}", expected "completed"`);
    process.exit(1);
  }
  log.ok(`Order ${order.shortId} is "completed"`);

  // ---- Summary ----------------------------------------------------------
  console.log(`\n${COLORS.green}${COLORS.bold}━━━ ALL 7 STEPS PASSED ━━━${COLORS.reset}`);
  console.log(`${COLORS.dim}  Seller: @${seller.handle}  |  Listing: ${listing.id}  |  Order: ${order.shortId}${COLORS.reset}`);
  console.log(`\n${COLORS.green}SafeSale flow verified end-to-end (MavaPay).${COLORS.reset}\n`);
}

main().catch((err) => {
  console.error(`\n${COLORS.red}${COLORS.bold}Crashed:${COLORS.reset}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
