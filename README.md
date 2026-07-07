# SafeSale Backend

> **Fastify REST API for SafeSale escrow — Nomba payments + PostgreSQL + Nostr.**  
> DevCareer × Nomba Hackathon submission.

---

## What This Is

The backend is a **Fastify** HTTP server written in TypeScript. It handles:

- **Authentication** (email/password JWT, Google OAuth)
- **Seller onboarding** (profile creation + Nomba bank account lookup)
- **Listings** (CRUD, stored in PostgreSQL)
- **Orders** (escrow lifecycle — Nomba virtual accounts, state machine)
- **Payments** (Nomba API: virtual accounts, bank transfers, webhook verification)
- **Disputes** (tiered resolution with mediator role)
- **Auto-release cron** (funds released 7 days after shipping if buyer doesn't act)

The frontend repo (`../frontend`) talks to this API via `src/lib/api/http.ts`.

---

## Quick Start

```bash
npm install
cp .env.example .env     # fill in the values below
npm run db:migrate       # create tables in your Postgres DB
npm run dev              # starts on http://localhost:3000
```

### Health check

```
GET http://localhost:3000/health
→ { "status": "ok", "timestamp": "..." }
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET` | ✅ | — | Min 16 chars. Used to sign/verify JWTs. |
| `JWT_EXPIRES_IN` | — | `7d` | JWT token lifetime |
| `FRONTEND_ORIGINS` | — | `http://localhost:8080` | Allowed CORS origins (comma-separated) |
| `FRONTEND_APP_URL` | — | `http://localhost:8080` | Used in email links |
| `NOMBA_CLIENT_ID` | ✅ | — | Nomba API client ID |
| `NOMBA_SECRET_KEY` | ✅ | — | Nomba API secret key |
| `NOMBA_ACCOUNT_ID` | ✅ | — | Nomba merchant account ID |
| `NOMBA_SIGNING_KEY` | ✅ | — | HMAC key for webhook signature verification |
| `NOMBA_BASE_URL` | — | `https://sandbox.nomba.com` | Use `https://api.nomba.com` for production |
| `NOMBA_MOCK` | — | `false` | `true` = return fake Nomba responses without API calls |
| `NOMBA_SIMULATION` | — | `false` | `true` = enable `POST /api/dev/simulate-payment` |
| `RESEND_API_KEY` | — | — | Resend API key for transactional email |
| `RESEND_FROM_EMAIL` | — | `SafeSale <onboarding@resend.dev>` | Sender address |
| `MEDIATOR_EMAIL` | — | `mediator@safesale.app` | Mediator login email |
| `MEDIATOR_PASSWORD` | — | `mediator-dev-password` | Mediator login password (change in production!) |
| `SAFESALE_NSEC` | — | — | Backend escrow Nostr private key (generated via `npm run keys:generate`) |
| `GOOGLE_CLIENT_ID` | — | — | Google OAuth client ID (optional) |
| `GOOGLE_CLIENT_SECRET` | — | — | Google OAuth client secret (optional) |

---

## API Reference

All endpoints return `Content-Type: application/json`. Errors follow the shape:

```json
{ "error": { "code": "ERROR_CODE", "message": "Human readable message" } }
```

### Auth

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `POST` | `/api/auth/register` | Public | `{ email, password }` | `{ token, user }` |
| `POST` | `/api/auth/login` | Public | `{ email, password }` | `{ token, user }` |
| `POST` | `/api/auth/google` | Public | `{ email, googleId }` | `{ token, user }` |
| `GET` | `/api/auth/me` | JWT | — | `{ user }` |
| `POST` | `/api/auth/mediator/login` | Public | `{ email, password }` | `{ token, user }` |

### Sellers

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/sellers` | JWT | Create seller profile (runs Nomba bank lookup) |
| `GET` | `/api/sellers/:handle` | Public | Public seller profile by handle |
| `PUT` | `/api/sellers` | JWT | Update seller profile (re-validates bank on change) |

### Listings

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/listings` | JWT | Create a product listing |
| `GET` | `/api/listings/:id` | Public | Get listing + seller info |
| `PATCH` | `/api/listings/:id` | JWT | Update listing fields |
| `DELETE` | `/api/listings/:id` | JWT | Soft-delete listing (`active = false`) |
| `GET` | `/api/listings?seller=<npub>` | Public | All listings by seller npub |

### Orders

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/orders` | Optional | Create order → returns Nomba virtual account details |
| `GET` | `/api/orders/:token` | Public | Order + listing + seller + dispute |
| `GET` | `/api/orders` | JWT | Seller's recent orders (last 7 days) |
| `GET` | `/api/orders/seller/:npub` | Public | All orders for a seller |
| `POST` | `/api/orders/:token/ship` | JWT | Mark shipped (requires `trackingNumber`) |
| `POST` | `/api/orders/:token/deliver` | JWT | Mark delivered |
| `POST` | `/api/orders/:token/release` | JWT | Release escrow → Nomba bank transfer to seller |

### Disputes

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/orders/:token/dispute` | JWT | Open a dispute on an order |
| `POST` | `/api/disputes` | JWT | Backend-native dispute creation |
| `GET` | `/api/disputes/:id` | JWT | Get dispute + messages |
| `POST` | `/api/disputes/:id/messages` | JWT | Add a message to a dispute |
| `POST` | `/api/disputes/:id/respond` | JWT | Seller responds (with optional evidence) |
| `GET` | `/api/admin/disputes` | Mediator | All disputes (mediator queue) |
| `POST` | `/api/admin/disputes/:id/resolve` | Mediator | Resolve dispute (refund / release / split) |
| `PATCH` | `/api/mediator/disputes/:id` | Mediator | Update dispute status/resolution |

### Webhooks & Dev

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/webhooks/nomba` | HMAC | Nomba payment confirmation webhook |
| `POST` | `/api/dev/simulate-payment` | Dev only | Simulate a Nomba payment (requires `NOMBA_SIMULATION=true`) |
| `GET` | `/health` | Public | Health check |

---

## Project Structure

```
backend/
├── src/
│   ├── index.ts              # Fastify app: CORS, route registration, error handler
│   ├── env.ts                # Zod env schema — fails fast if any required var is missing
│   │
│   ├── db/
│   │   └── client.ts         # Prisma client singleton
│   │
│   ├── middleware/
│   │   └── auth.ts           # requireAuth / optionalAuth / requireMediator
│   │                         # Verifies JWT, injects req.user
│   │
│   ├── routes/
│   │   ├── auth.ts           # /api/auth/* — register, login, Google, mediator
│   │   ├── sellers.ts        # /api/sellers/* — onboarding, profile, bank verification
│   │   ├── listings.ts       # /api/listings/* — CRUD for product listings
│   │   ├── orders.ts         # /api/orders/* — escrow lifecycle
│   │   ├── disputes.ts       # /api/disputes/*, /api/orders/:token/dispute, /api/admin/disputes/*
│   │   ├── nomba.ts          # /api/webhooks/nomba — payment webhook handler
│   │   └── dev.ts            # /api/dev/simulate-payment — dev-only funding simulation
│   │
│   ├── services/
│   │   ├── auth.ts           # register(), login(), findOrCreateGoogleUser()
│   │   ├── nomba.ts          # Nomba API: virtual accounts, bank lookup, transfers, webhooks
│   │   ├── email.ts          # Resend email templates (order confirmation, etc.)
│   │   ├── nostr.ts          # Nostr keypair generation, relay event publishing
│   │   └── scheduler.ts      # Auto-release cron — runs every 5 min
│   │
│   └── lib/
│       ├── errors.ts         # HttpError, NotFound, BadRequest, Forbidden, Unauthorized, ServiceUnavailable
│       ├── logger.ts         # Pino logger instance (JSON in production, pretty in dev)
│       └── normalize.ts      # DB model → API response converters
│
├── prisma/
│   ├── schema.prisma         # Database schema
│   └── migrations/           # Migration history
│
└── scripts/
    ├── generate-keys.ts      # Generate Nostr keypairs for backend identity
    └── smoke-test.ts         # End-to-end API smoke test
```

---

## Database Schema

```
User ──────────── Seller
                    ├── Listing[] ──── Order[]
                    └── Order[] ────── Dispute
                                         └── DisputeMessage[]
WebhookEvent (standalone, idempotency store)
```

### Escrow Order States

```
pending_payment → funded → shipped → delivered → released
                                ↘                ↗
                               disputed → (mediator) → refunded
```

---

## Nomba Integration

The `services/nomba.ts` module wraps the Nomba API:

1. **Token management** — OAuth2 client credentials, auto-refreshed 5 min before expiry.
2. **Virtual accounts** — `createVirtualAccount()` — called on every new order. Returns a unique account number, account name, and bank name that the buyer transfers to.
3. **Bank lookup** — `bankAccountLookup()` — called on seller creation/update to verify and cache `bankAccountName`.
4. **Bank transfer** — `transferToBank()` — called on escrow release. Sends NGN to the seller's registered bank account.
5. **Webhook verification** — `verifyWebhookSignature()` — HMAC-SHA256 over a canonical payload string using `NOMBA_SIGNING_KEY`.

### Development without Nomba

Set `NOMBA_MOCK=true` in your `.env` to skip all real Nomba API calls. All functions return realistic fake data. The webhook simulation can then be triggered via `POST /api/dev/simulate-payment`.

---

## Running in Production

```bash
# Build
npm run build           # runs: prisma generate && tsc

# Start (migrates DB, then starts server)
npm start               # runs: prisma migrate deploy && node dist/src/index.js

# Required env vars in production:
# DATABASE_URL (Postgres connection string)
# JWT_SECRET (strong random string, min 32 chars recommended)
# NOMBA_CLIENT_ID, NOMBA_SECRET_KEY, NOMBA_ACCOUNT_ID, NOMBA_SIGNING_KEY
# NOMBA_BASE_URL=https://api.nomba.com  (live, not sandbox)
# FRONTEND_ORIGINS (your deployed frontend domain)
# FRONTEND_APP_URL (your deployed frontend URL)
# RESEND_API_KEY (for transactional emails)
# MEDIATOR_EMAIL, MEDIATOR_PASSWORD (strong password in production!)
```

Recommended hosting: **Render** (Node.js service + managed PostgreSQL).

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Development server with hot reload (`tsx watch`) |
| `npm run build` | Production build (Prisma generate + TypeScript compile) |
| `npm start` | Production start (migrate + run) |
| `npm run db:migrate` | Create and apply a new Prisma migration |
| `npm run db:generate` | Regenerate Prisma client after schema changes |
| `npm run db:studio` | Open Prisma Studio in browser |
| `npm run db:deploy` | Apply pending migrations (used in production) |
| `npm run keys:generate` | Generate Nostr keypairs for `SAFESALE_NSEC`/`MEDIATOR_NSEC` |
| `npm run smoke` | Run end-to-end smoke tests against a running server |
| `npm run typecheck` | TypeScript type check without emitting files |

---

## Tech Stack

| Concern | Package | Version |
|---|---|---|
| HTTP framework | `fastify` | 5.x |
| CORS | `@fastify/cors` | 10.x |
| ORM | `@prisma/client` / `prisma` | 6.x |
| Validation | `zod` | 3.x |
| Auth | `jsonwebtoken` + `bcrypt` | 9.x / 5.x |
| Logging | `pino` + `pino-pretty` | 9.x / 13.x |
| Nostr | `nostr-tools` + `@nostrify/nostrify` | 2.x / 0.52.x |
| TypeScript runner | `tsx` | 4.x |
| OAuth | `passport` + `passport-google-oauth20` | 0.7.x / 2.x |

---

## Notes

- **Node.js ≥ 22** is required (specified in `.nvmrc`).
- The server uses ES modules (`"type": "module"` in package.json) — all imports must use `.js` extensions.
- Pino logger outputs JSON in production and pretty-printed text in development.
- The `normalize.ts` module converts Prisma model shapes to API-safe response shapes (e.g., removes internal fields, standardises dates).
