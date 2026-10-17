import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt, { SignOptions } from 'jsonwebtoken';
import type { User } from '@prisma/client';
import { prisma } from '../db/client.js';
import { env } from '../env.js';
import { Conflict, ServiceUnavailable, Unauthorized } from '../lib/errors.js';

const BCRYPT_ROUNDS = 12;
const JWT_ALGORITHM = 'HS256';
// Compared against when the email doesn't exist, so login timing is uniform.
const DUMMY_HASH = bcrypt.hashSync('safesale-timing-equalizer', BCRYPT_ROUNDS);

export interface JwtPayload {
  sub: string;
  email: string;
  nostrNpub: string | null;
  role?: string;
}

/**
 * Opaque public id for a user. Still stored in the legacy `nostrNpub`
 * column and used as `Seller.npub`; nothing about it is Nostr anymore.
 */
function generatePublicId(): string {
  return `ss_${crypto.randomBytes(16).toString('base64url')}`;
}

function generateToken(user: Pick<User, 'id' | 'email' | 'nostrNpub' | 'role'>): string {
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    nostrNpub: user.nostrNpub,
    role: user.role,
  };
  const options: SignOptions = { expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'], algorithm: JWT_ALGORITHM };
  return jwt.sign(payload, env.JWT_SECRET, options);
}

export function verifyToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET, { algorithms: [JWT_ALGORITHM] }) as JwtPayload;
  } catch {
    throw new Unauthorized('Invalid or expired token');
  }
}

function session(user: User) {
  return {
    token: generateToken(user),
    user: { id: user.id, email: user.email, nostrNpub: user.nostrNpub },
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isMediatorEmail(email: string): boolean {
  return normalizeEmail(email) === normalizeEmail(env.MEDIATOR_EMAIL);
}

export async function register(rawEmail: string, password: string) {
  const email = normalizeEmail(rawEmail);
  if (isMediatorEmail(email)) throw new Conflict('A user with this email already exists');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new Conflict('A user with this email already exists');

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      authProvider: 'EMAIL',
      nostrNpub: generatePublicId(),
    },
  });
  return session(user);
}

export async function login(rawEmail: string, password: string) {
  const email = normalizeEmail(rawEmail);
  // The mediator signs in through the normal form with the configured credentials.
  if (isMediatorEmail(email)) return mediatorLogin(password);

  const user = await prisma.user.findUnique({ where: { email } });
  // Always run bcrypt so response time doesn't reveal whether the email exists.
  const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !valid) throw new Unauthorized('Invalid email or password');
  return session(user);
}

async function mediatorLogin(password: string) {
  const expected = env.MEDIATOR_PASSWORD;
  const a = Buffer.from(password);
  const b = Buffer.from(expected ?? '');
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Unauthorized('Invalid email or password');
  }

  // The mediator is a real user row so dispute messages can reference it.
  const email = normalizeEmail(env.MEDIATOR_EMAIL);
  const user = await prisma.user.upsert({
    where: { email },
    update: { role: 'MEDIATOR', passwordHash: null },
    create: { email, role: 'MEDIATOR', authProvider: 'EMAIL', nostrNpub: generatePublicId() },
  });
  return session(user);
}

interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Verify a Google OAuth access token: it must have been issued to OUR
 * client id, and Google must vouch for the email it carries.
 */
async function verifyGoogleAccessToken(accessToken: string): Promise<GoogleIdentity> {
  if (!env.GOOGLE_CLIENT_ID) throw new ServiceUnavailable('Google sign-in is not configured');

  let info: { aud?: string; azp?: string; sub?: string; email?: string; email_verified?: string | boolean; error?: string };
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    info = (await res.json()) as typeof info;
    if (!res.ok) throw new Unauthorized('Invalid Google token');
  } catch (err) {
    if (err instanceof Unauthorized) throw err;
    throw new ServiceUnavailable('Could not reach Google to verify sign-in');
  }

  const audience = info.aud ?? info.azp;
  if (audience !== env.GOOGLE_CLIENT_ID || !info.sub || !info.email) {
    throw new Unauthorized('Invalid Google token');
  }
  return {
    sub: info.sub,
    email: normalizeEmail(info.email),
    emailVerified: info.email_verified === true || info.email_verified === 'true',
  };
}

export async function googleLogin(accessToken: string) {
  const google = await verifyGoogleAccessToken(accessToken);
  if (!google.emailVerified) throw new Unauthorized('Your Google email address is not verified');
  if (isMediatorEmail(google.email)) throw new Unauthorized('Use email and password to sign in');

  const byGoogleId = await prisma.user.findUnique({ where: { googleId: google.sub } });
  if (byGoogleId) return session(byGoogleId);

  // Link to an existing email/password account — safe only because Google
  // has verified ownership of this email.
  const byEmail = await prisma.user.findUnique({ where: { email: google.email } });
  if (byEmail) {
    if (byEmail.googleId) throw new Unauthorized('This email is linked to a different Google account');
    return session(await prisma.user.update({ where: { id: byEmail.id }, data: { googleId: google.sub } }));
  }

  const user = await prisma.user.create({
    data: {
      email: google.email,
      googleId: google.sub,
      authProvider: 'GOOGLE',
      emailVerified: true,
      nostrNpub: generatePublicId(),
    },
  });
  return session(user);
}
