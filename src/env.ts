import 'dotenv/config';
import { z } from 'zod';
import { logger } from './lib/logger.js';

const EnvSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  FRONTEND_ORIGINS: z
    .string()
    .default('http://localhost:8080')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),
  FRONTEND_ORIGIN_REGEXES: z
    .string()
    .default('^https://([a-z0-9-]+\\.)*vercel\\.app$')
    .transform((s) =>
      s.split(',').map((p) => p.trim()).filter(Boolean).map((p) => new RegExp(p)),
    ),
  FRONTEND_APP_URL: z
    .string()
    .default('http://localhost:8080')
    .transform((v) => v.replace(/\/+$/, ''))
    .pipe(z.string().url()),

  // Database
  DATABASE_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined))
    .pipe(z.string().url().optional()),

  // JWT Auth
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional().transform((v) => v || undefined),
  GOOGLE_CLIENT_SECRET: z.string().optional().transform((v) => v || undefined),

  // Facebook OAuth (post-MVP)
  FACEBOOK_APP_ID: z.string().optional().transform((v) => v || undefined),
  FACEBOOK_APP_SECRET: z.string().optional().transform((v) => v || undefined),

  // SafeSale brand Nostr identity
  SAFESALE_NSEC: z.string().optional().transform((v) => v || undefined),
  SAFESALE_NPUB: z.string().optional().transform((v) => v || undefined),
  MEDIATOR_NSEC: z.string().optional().transform((v) => v || undefined),
  MEDIATOR_NPUB: z.string().optional().transform((v) => v || undefined),

  // Nostr relays
  NOSTR_RELAYS: z
    .string()
    .default('wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
    .transform((s) => s.split(',').map((u) => u.trim()).filter(Boolean)),

  // Nomba — payments (virtual accounts, transfers, webhooks)
  NOMBA_CLIENT_ID: z.string().optional().transform((v) => v || undefined),
  NOMBA_SECRET_KEY: z.string().optional().transform((v) => v || undefined),
  NOMBA_ACCOUNT_ID: z.string().optional().transform((v) => v || undefined),
  NOMBA_SIGNING_KEY: z.string().optional().transform((v) => v || undefined),
  NOMBA_BASE_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : 'https://sandbox.nomba.com'))
    .pipe(z.string().url()),
  NOMBA_SIMULATION: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  NOMBA_MOCK: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // SafeSale fee
  SAFESALE_FEE_LN_ADDRESS: z.string().optional().transform((v) => v || undefined),

  // Email (Resend)
  RESEND_API_KEY: z.string().optional().transform((v) => v || undefined),
  RESEND_FROM_EMAIL: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : 'SafeSale <onboarding@resend.dev>')),
  RESEND_TEST_TO_EMAIL: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined))
    .pipe(z.string().email().optional()),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  logger.fatal({ issues: parsed.error.issues }, 'Invalid environment configuration');
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
