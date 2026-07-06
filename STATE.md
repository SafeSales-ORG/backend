# SafeSale Backend — State Checkpoint

**Date:** 2026-07-06
**Goal:** Migrate SafeSale backend from MavaPay+Nostr-auth to Nomba+JWT-auth for DevCareer x Nomba Hackathon
**Status:** Routes adapted, schema finalized, server compiles cleanly

## Architecture

### Stack
- **Runtime:** Node.js, Fastify, TypeScript
- **Database:** PostgreSQL (Render), Prisma ORM
- **Auth:** JWT (bcrypt + jsonwebtoken) + Google OAuth placeholder
- **Payments:** Nomba API (virtual accounts, bank transfers, webhooks)
- **Messaging:** Nostr (keypairs generated on signup, DMs via relay)
- **Email:** Resend (transactional emails)

### Database Models (6)
1. **User** — Auth provider, email, Nostr keypair, relations to Seller + Order
2. **Seller** — Profile, bank details (bankCode, bankAccountNumber, bankAccountName), Nostr npub, handle
3. **Listing** — Product listing with priceNGN, images (JSON), stock, variants
4. **Order** — Escrow with Nomba VA details (accountNumber, accountName, bankName), bank transfer on release, status flow: `pending_payment` → `funded` → `shipped` → `completed`
5. **Dispute** — Resolution tracking
6. **WebhookEvent** — Idempotent Nomba webhook processing

### Key Design Decisions
- `bankCode` required on Seller (prevents fallback-to-name bug)
- `bankAccountName` populated via Nomba bank lookup on seller creation/update
- `orderToken` used as Nomba VA `accountRef` → matched in webhook by `aliasAccountReference`
- Double-payout prevention: `prisma.order.updateMany({ where: { id, status: 'shipped' } })` in scheduler
- `NOMBA_SIMULATION` uses `z.string().transform(v => v === 'true')` to avoid truthy-string bug
- Nostr keypair auto-generated on JWT signup (available for messaging layer)

## Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | - | Email+password registration |
| POST | `/api/auth/login` | - | JWT login |
| POST | `/api/auth/google` | - | Google OAuth login |
| GET | `/api/auth/me` | JWT | Current user info |
| POST | `/api/sellers` | JWT | Create seller profile (incl. Nomba bank lookup) |
| GET | `/api/sellers/:handle` | - | Public seller profile |
| PUT | `/api/sellers` | JWT | Update seller (re-verifies bank on change) |
| POST | `/api/listings` | JWT | Create listing |
| GET | `/api/listings/:id` | - | Get listing + seller |
| GET | `/api/listings` | - | List by seller npub (`?seller=<npub>`) |
| POST | `/api/orders` | Optional | Create escrow order (Nomba VA) |
| GET | `/api/orders/:token` | - | Order status |
| GET | `/api/orders` | JWT | Seller's recent orders |
| POST | `/api/orders/:token/release` | JWT | Release funds to seller (Nomba transfer) |
| POST | `/api/webhooks/nomba` | HMAC | Nomba payment success webhook |
| POST | `/api/dev/simulate-payment` | Dev only | Simulate funding (when `NOMBA_SIMULATION=true`) |
| GET | `/health` | - | Health check |

## Cron Jobs
- **Auto-release:** Every 5 min, releases `shipped` orders past `autoReleaseAt`. Uses `transferToBank` with 1% fee. Double-payout safe via `updateMany`.

## Running
```bash
npm run dev    # tsx watch src/index.ts
npm run build  # tsc
npm start      # node dist/index.js
```

## Env Required
- `DATABASE_URL`, `JWT_SECRET`, `RESEND_API_KEY`, `FRONTEND_ORIGINS`
- `NOMBA_BASE_URL`, `NOMBA_CLIENT_ID`, `NOMBA_SECRET_KEY`, `NOMBA_ACCOUNT_ID`
- `NOMBA_SIGNING_KEY` (webhook HMAC)
- `NOMBA_SIMULATION` (optional, `"true"` enables dev routes)
- `SUPPORT_EMAIL`, `PLATFORM_FEE_BPS`

## Completed (Latest Round)
- Smoke test: full flow verified (15/15 passing) ✓
- Stale `scripts/smoke.ts` deleted (MavaPay-era) ✓
- `email.ts` field rename (`amountNGN` → `priceNGN`) ✓
- Package.json `npm run smoke` now points to `scripts/smoke-test.ts` ✓

## Next Steps
1. Set up `.env.production` for mainnet deployment (real Nomba credentials, different JWT secret, production DB)
2. Frontend integration (separate developer)
