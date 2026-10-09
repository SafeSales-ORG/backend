# SafeSale — Backend

Fastify + Prisma + PostgreSQL API for SafeSale, a Naira escrow service for
social-commerce sellers. The buyer pays into an account issued for their
order, the money is held, and it's released to the seller only when the
buyer confirms, the inspection window passes, or a mediator decides.

The frontend lives in the sibling `frontend` repo and talks to this API
through `src/lib/api/http.ts`.

## Quick start

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL and JWT_SECRET at minimum
npx prisma migrate deploy   # create tables
npm run dev                 # http://localhost:3000  (GET /health)
```

With `PAYMENT_PROVIDER=mock` and `PAYMENT_SIMULATION=true` (the defaults in
`.env.example`) the whole escrow flow works locally without a payment
provider account.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with hot reload |
| `npm test` | Integration tests against a throwaway Postgres (downloads it on first run) |
| `npm run typecheck` | TypeScript check |
| `npm run build` / `npm start` | Production build / run (start applies migrations first) |
| `npm run db:migrate` | Create a new migration after editing `prisma/schema.prisma` |

## How escrow works

```
pending_payment ──payment webhook──▶ funded ──seller ships──▶ shipped ──buyer confirms──▶ delivered
                                       │                        │                            │
                                       └────────── buyer releases, or auto-release ──────────┴──▶ released
                                       └────────── buyer/seller opens dispute ──▶ disputed ──mediator──▶ released | refunded
```

- **Two tokens per order.** `orderToken` is the shared reference the seller
  sees. `buyerToken` is the buyer's secret: it's in their order link and
  email, and it's required to confirm delivery, release funds, or open a
  dispute as the buyer. The seller never receives it.
- **Auto-release.** Shipping sets `autoReleaseAt` to `AUTO_RELEASE_DAYS`
  later. Opening a dispute clears it. A scheduler releases due orders every
  5 minutes.
- **Payouts are idempotent.** Every status change that moves money claims
  the order with a conditional update and writes a `Payout` row (unique per
  order and kind, with a fixed provider reference) in the same transaction,
  before calling the provider. Payouts whose outcome is unknown are retried
  with the same reference; rejected ones are marked `failed` for a human.
- **Refunds** are recorded as `manual` payouts — we don't collect buyer bank
  details yet, so a person pays them.
- **Fee.** `PLATFORM_FEE_BPS` is deducted from the seller's payout.

Code: `src/services/escrow.ts` (all money-moving transitions),
`src/routes/orders.ts`, `src/routes/disputes.ts`.

## Payment providers

All provider calls go through the interface in
`src/services/payments/types.ts` (create pay-in account, resolve bank
account, transfer). Implementations:

- `mock.ts` — local development, no network.
- `nomba.ts` — Nomba. Webhook: `POST /api/webhooks/nomba`, verified with
  `NOMBA_SIGNING_KEY` (webhooks are rejected if it isn't set).

To add OPay: implement `PaymentProvider` in `payments/opay.ts`, add it to
`payments/index.ts`, and add its webhook route (verify the signature, then
call `markFunded` from `services/escrow.ts`).

## Image uploads

`POST /api/uploads` with `{ "dataUrl": "data:image/…;base64,…" }` returns
`{ url }`. Allowed: a signed-in user, or a buyer sending their order's
`X-Buyer-Token` (paid orders only — for dispute evidence). The server checks
the actual bytes (JPEG, PNG or WebP only — no SVG), enforces
`UPLOAD_MAX_BYTES`, and stores the file under a random key.

Storage is set by `STORAGE_PROVIDER`:

- `none` (default) — uploads return 503 and the frontend keeps photos inline
  in the database, as before.
- `local` — files saved to `STORAGE_LOCAL_DIR`, served at `/uploads`.
  Development only (refused in production: disk is wiped on redeploy).
- `s3` — any S3-compatible bucket (Cloudflare R2, AWS S3, DigitalOcean
  Spaces, Supabase Storage, Backblaze B2). Set `S3_*` and
  `STORAGE_PUBLIC_URL` (the public bucket/CDN URL). Add a bucket lifecycle
  rule if you want to expire unused uploads.

## Auth

- Email/password → JWT (HS256, `JWT_SECRET`). Login and sign-up are rate
  limited per IP.
- Google: the frontend sends the Google **access token**; the backend asks
  Google whether it was issued to `GOOGLE_CLIENT_ID` and only trusts a
  verified email.
- Mediator: sign in on the normal login form with `MEDIATOR_EMAIL` /
  `MEDIATOR_PASSWORD`. The mediator gets a real user row with role
  `MEDIATOR`.

## API

Errors are always `{ "error": { "code", "message", "details?" } }`.

| Method & path | Who | Notes |
|---|---|---|
| `POST /api/auth/register` · `/login` · `/google` | anyone | returns `{ token, user }` |
| `GET /api/auth/me` | signed in | |
| `POST /api/sellers` · `PUT /api/sellers` | signed in | bank account is verified with the provider |
| `GET /api/sellers/me` | seller | own profile + payout account (number masked) |
| `GET /api/sellers/:handle` | anyone | public profile |
| `POST /api/listings` · `PATCH`/`DELETE /api/listings/:id` | seller (owner) | |
| `GET /api/listings/mine` | seller | all of the caller's listings, including hidden ones |
| `GET /api/listings` | anyone | marketplace feed: newest active, in-stock listings with public seller info (`?limit=`, max 100) |
| `GET /api/listings/:id` · `GET /api/listings?seller=` | anyone | active listings only |
| `POST /api/orders` | anyone | returns `{ order, buyerToken, payment }` |
| `GET /api/orders/:token` | buyer or seller token | |
| `GET /api/orders` · `GET /api/orders/seller/:npub` | seller (own shop) | |
| `POST /api/orders/:orderToken/ship` | seller | starts the auto-release clock |
| `POST /api/orders/:buyerToken/deliver` · `/release` | buyer | |
| `POST /api/orders/:token/dispute` | buyer (buyerToken) or seller (orderToken + session) | |
| `GET /api/disputes/:id` · `POST …/messages` · `POST …/respond` | participants | |
| `GET /api/admin/disputes` · `POST /api/admin/disputes/:id/resolve` | mediator | |
| `POST /api/uploads` | seller, or buyer via `X-Buyer-Token` | image upload, returns `{ url }` |
| `POST /api/dev/simulate-payment` | dev only | only exists when `PAYMENT_SIMULATION=true` and not production |

## Database migrations

`prisma/migrations/0_baseline` matches the schema the hackathon deployment
was running; `1_escrow_hardening` adds payouts, the buyer token, and paid
amount tracking, and drops the unused plaintext Nostr keys.

**Existing database** (already has the tables): mark the baseline as
applied once, then deploy:

```bash
npx prisma migrate status                      # check what it thinks first
npx prisma migrate resolve --applied 0_baseline
npx prisma migrate deploy
```

**New database:** `npx prisma migrate deploy` applies both.

## Production checklist

- `NODE_ENV=production`, `JWT_SECRET` ≥ 32 random characters (the server
  refuses to start otherwise).
- A real `PAYMENT_PROVIDER` with its webhook signing key (mock is refused in
  production; simulation is always off in production).
- `MEDIATOR_PASSWORD` set to a strong password.
- `FRONTEND_ORIGINS` lists only your real frontend URLs.
