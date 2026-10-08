import 'dotenv/config';
import { z } from 'zod';
import { logger } from './lib/logger.js';

const optionalString = z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined));
const flag = z.string().optional().transform((v) => v === 'true');

const EnvSchema = z
  .object({
    // Server
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    FRONTEND_ORIGINS: z
      .string()
      .default('http://localhost:8080')
      .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),
    // Optional extra origin patterns (e.g. preview deployments). Empty by default.
    FRONTEND_ORIGIN_REGEXES: z
      .string()
      .default('')
      .transform((s) =>
        s.split(',').map((p) => p.trim()).filter(Boolean).map((p) => new RegExp(p)),
      ),
    FRONTEND_APP_URL: z
      .string()
      .default('http://localhost:8080')
      .transform((v) => v.replace(/\/+$/, ''))
      .pipe(z.string().url()),

    // Database
    DATABASE_URL: z.string().url(),

    // Requests per minute per IP on login/sign-up endpoints.
    AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),

    // JWT Auth
    JWT_SECRET: z.string().min(16),
    JWT_EXPIRES_IN: z.string().default('7d'),

    // Google sign-in: access tokens must have been issued to this client.
    GOOGLE_CLIENT_ID: optionalString,

    // Payments
    //  - nomba: real Nomba API (sandbox or live per NOMBA_BASE_URL)
    //  - mock:  fake pay-in accounts and transfers, no network calls
    PAYMENT_PROVIDER: z.enum(['nomba', 'mock']).default('mock'),
    // Enables POST /api/dev/simulate-payment. Never honoured in production.
    PAYMENT_SIMULATION: flag,
    // SafeSale's fee on released funds, in basis points (100 = 1%).
    PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(2000).default(0),
    // Days after shipping before funds auto-release to the seller if the
    // buyer neither confirms nor disputes.
    AUTO_RELEASE_DAYS: z.coerce.number().int().min(1).max(60).default(7),

    NOMBA_CLIENT_ID: optionalString,
    NOMBA_SECRET_KEY: optionalString,
    NOMBA_ACCOUNT_ID: optionalString,
    NOMBA_SIGNING_KEY: optionalString,
    NOMBA_BASE_URL: z
      .string()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : 'https://sandbox.nomba.com'))
      .pipe(z.string().url()),

    // Mediator. Login is disabled until MEDIATOR_PASSWORD is set.
    MEDIATOR_EMAIL: z.string().email().default('mediator@safesale.app'),
    MEDIATOR_PASSWORD: z
      .string()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined))
      .pipe(z.string().min(12).optional()),

    // Email (Resend)
    RESEND_API_KEY: optionalString,
    RESEND_FROM_EMAIL: z
      .string()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : 'SafeSale <onboarding@resend.dev>')),
    RESEND_TEST_TO_EMAIL: z
      .string()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined))
      .pipe(z.string().email().optional()),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV !== 'production') return;
    if (e.JWT_SECRET.length < 32) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'Must be at least 32 characters in production' });
    }
    if (e.PAYMENT_PROVIDER === 'mock') {
      ctx.addIssue({ code: 'custom', path: ['PAYMENT_PROVIDER'], message: 'The mock provider cannot be used in production' });
    }
    if (e.PAYMENT_PROVIDER === 'nomba' && !e.NOMBA_SIGNING_KEY) {
      ctx.addIssue({ code: 'custom', path: ['NOMBA_SIGNING_KEY'], message: 'Required in production to verify webhooks' });
    }
  });

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  logger.fatal({ issues: parsed.error.issues }, 'Invalid environment configuration');
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/** Simulated payments are a dev/staging convenience only. */
export const paymentSimulationEnabled = env.PAYMENT_SIMULATION && env.NODE_ENV !== 'production';
