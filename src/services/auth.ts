import bcrypt from 'bcrypt';
import jwt, { SignOptions } from 'jsonwebtoken';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { prisma } from '../db/client.js';
import { env } from '../env.js';
import { Conflict, Unauthorized } from '../lib/errors.js';

const BCRYPT_ROUNDS = 12;

export interface JwtPayload {
  sub: string;
  email: string;
  nostrNpub: string | null;
  role?: string;
}

function generateNostrKeypair(): { nsec: string; npub: string } {
  const sk = generateSecretKey();
  const nsec = nip19.nsecEncode(sk);
  const npub = nip19.npubEncode(getPublicKey(sk));
  return { nsec, npub };
}

function generateToken(user: { id: string; email: string; nostrNpub: string | null }): string {
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    nostrNpub: user.nostrNpub,
  };
  const options: SignOptions = { expiresIn: env.JWT_EXPIRES_IN as any };
  return jwt.sign(payload, env.JWT_SECRET, options);
}

export function verifyToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    throw new Unauthorized('Invalid or expired token');
  }
}

export async function register(email: string, password: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new Conflict('A user with this email already exists');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const { nsec, npub } = generateNostrKeypair();

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      authProvider: 'EMAIL',
      nostrNsec: nsec,
      nostrNpub: npub,
    },
  });

  const token = generateToken(user);
  return {
    token,
    user: { id: user.id, email: user.email, nostrNpub: user.nostrNpub },
  };
}

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    throw new Unauthorized('Invalid email or password');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new Unauthorized('Invalid email or password');
  }

  const token = generateToken(user);
  return {
    token,
    user: { id: user.id, email: user.email, nostrNpub: user.nostrNpub },
  };
}

export async function findOrCreateGoogleUser(googleId: string, email: string) {
  let user = await prisma.user.findFirst({
    where: { OR: [{ googleId }, { email }] },
  });

  if (user) {
    if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId, authProvider: 'GOOGLE' },
      });
    }
    const token = generateToken(user);
    return {
      token,
      user: { id: user.id, email: user.email, nostrNpub: user.nostrNpub },
    };
  }

  const { nsec, npub } = generateNostrKeypair();
  user = await prisma.user.create({
    data: {
      email,
      googleId,
      authProvider: 'GOOGLE',
      nostrNsec: nsec,
      nostrNpub: npub,
    },
  });

  const token = generateToken(user);
  return {
    token,
    user: { id: user.id, email: user.email, nostrNpub: user.nostrNpub },
  };
}
