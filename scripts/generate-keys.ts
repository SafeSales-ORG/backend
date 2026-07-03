/**
 * One-shot Nostr keypair generator for the SafeSale brand identity.
 *
 * Run once with: npm run keys:generate
 *
 * Prints both an nsec (private — KEEP SECRET) and npub (public — share freely).
 * Copy both into your .env. The script never writes to .env directly so you
 * stay in full control of where the secret goes.
 *
 * This keypair is used to:
 *   - Send system Nostr DMs to sellers ("Payment locked — ship now")
 *   - Sign mediator decisions on dispute resolutions (post-MVP)
 *   - Identify the "SafeSale" brand account on relays
 */

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const sk = generateSecretKey(); // Uint8Array (32 bytes)
const pk = getPublicKey(sk); // hex string

const nsec = nip19.nsecEncode(sk);
const npub = nip19.npubEncode(pk);

const skHex = Array.from(sk)
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');

const line = '─'.repeat(72);

console.log();
console.log(line);
console.log('  SafeSale brand Nostr keypair');
console.log(line);
console.log();
console.log('  npub (public — safe to share, put in README/UI):');
console.log(`    ${npub}`);
console.log();
console.log('  nsec (PRIVATE — never commit, never share):');
console.log(`    ${nsec}`);
console.log();
console.log('  Hex pubkey (for relay filters):');
console.log(`    ${pk}`);
console.log();
console.log('  Hex secret (for advanced libs):');
console.log(`    ${skHex}`);
console.log();
console.log(line);
console.log('  Next steps:');
console.log('    1. Copy SAFESALE_NSEC and SAFESALE_NPUB to your .env');
console.log('    2. For MVP: set MEDIATOR_NSEC=<same nsec> and MEDIATOR_NPUB=<same npub>');
console.log('    3. Back up the nsec in a password manager (1Password / Bitwarden)');
console.log('    4. Never commit .env');
console.log(line);
console.log();
