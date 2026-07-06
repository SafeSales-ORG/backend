import { SimplePool, finalizeEvent, getPublicKey, nip04, nip19 } from 'nostr-tools';
import type { Event, EventTemplate, UnsignedEvent } from 'nostr-tools';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

let _pool: SimplePool | null = null;
let _brandSecretKey: Uint8Array | null = null;
let _brandPubkey: string | null = null;

function getPool(): SimplePool {
  if (!_pool) _pool = new SimplePool();
  return _pool;
}

function getBrandKey(): { sk: Uint8Array; pk: string } {
  if (_brandSecretKey && _brandPubkey) {
    return { sk: _brandSecretKey, pk: _brandPubkey };
  }
  if (!env.SAFESALE_NSEC) {
    throw new Error('SAFESALE_NSEC not set — cannot use Nostr brand identity');
  }
  const decoded = nip19.decode(env.SAFESALE_NSEC);
  if (decoded.type !== 'nsec') {
    throw new Error(`SAFESALE_NSEC is not a valid nsec (got ${decoded.type})`);
  }
  _brandSecretKey = decoded.data;
  _brandPubkey = getPublicKey(_brandSecretKey);
  return { sk: _brandSecretKey, pk: _brandPubkey };
}

async function publishToRelays(event: Event): Promise<Event> {
  const pool = getPool();
  const relays = env.NOSTR_RELAYS;
  try {
    await Promise.any(pool.publish(relays, event));
    logger.info(
      { id: event.id.substring(0, 16) + '…', kind: event.kind, relays: relays.length },
      'Nostr event published',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    logger.warn({ kind: event.kind, err: msg }, 'Nostr publish failed on all relays');
    throw new Error(`Nostr publish failed: ${msg}`);
  }
  return event;
}

async function publishAsBrand(template: EventTemplate): Promise<Event> {
  const { sk } = getBrandKey();
  const event = finalizeEvent(template, sk);
  return publishToRelays(event);
}

export async function publishBrandProfile(): Promise<Event> {
  const profile = {
    name: 'safesale',
    display_name: 'SafeSale',
    about:
      'Escrow for social commerce. Nomba · Nostr. DevCareer x Nomba 2026.',
    nip05: 'safesale@safesale.app',
  };
  return publishAsBrand({
    kind: 0,
    content: JSON.stringify(profile),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  });
}

export async function sendBrandDM(
  recipientPubkeyHex: string,
  plaintext: string,
): Promise<Event> {
  const { sk } = getBrandKey();
  const ciphertext = await nip04.encrypt(sk, recipientPubkeyHex, plaintext);
  return publishAsBrand({
    kind: 4,
    content: ciphertext,
    tags: [['p', recipientPubkeyHex]],
    created_at: Math.floor(Date.now() / 1000),
  });
}

export function buildListingEvent(
  sellerPubkeyHex: string,
  listing: {
    id: string;
    title: string;
    description: string;
    priceNGN: number;
    category: string;
    images: { url?: string; seed?: string; alt?: string }[];
  },
): UnsignedEvent {
  return {
    pubkey: sellerPubkeyHex,
    kind: 30018,
    content: JSON.stringify({
      id: listing.id,
      stall_id: 'safesale',
      name: listing.title,
      description: listing.description,
      images: listing.images.map((i) => i.url).filter(Boolean),
      currency: 'NGN',
      price: listing.priceNGN,
      quantity: 1,
    }),
    tags: [
      ['d', listing.id],
      ['t', listing.category.toLowerCase().replace(/\s+/g, '-')],
      ['alt', `SafeSale listing: ${listing.title}`],
    ],
    created_at: Math.floor(Date.now() / 1000),
  };
}

export function buildReviewEvent(
  reviewerPubkeyHex: string,
  subjectPubkeyHex: string,
  rating: number,
  comment?: string,
): UnsignedEvent {
  return {
    pubkey: reviewerPubkeyHex,
    kind: 1985,
    content: comment ?? '',
    tags: [
      ['L', 'safesale.trade'],
      ['l', 'completed', 'safesale.trade'],
      ['p', subjectPubkeyHex],
      ['rating', String(rating)],
      ['alt', `SafeSale trade review: ${rating}/5`],
    ],
    created_at: Math.floor(Date.now() / 1000),
  };
}

export function getBrandPubkey(): string {
  return getBrandKey().pk;
}
