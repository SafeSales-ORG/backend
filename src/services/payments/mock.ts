import crypto from 'node:crypto';
import type { PaymentProvider } from './types.js';

/** Local-development provider: no network calls, everything succeeds. */
export const mockProvider: PaymentProvider = {
  name: 'mock',

  async createPayInAccount({ reference, accountName }) {
    const digits = crypto.createHash('sha256').update(reference).digest().readUInt32BE(0);
    return {
      accountNumber: String(9_000_000_000 + (digits % 1_000_000_000)),
      accountName,
      bankName: 'Mock Bank',
      reference,
    };
  },

  async resolveBankAccount() {
    return { accountName: 'Test Account Holder' };
  },

  async transfer({ reference }) {
    return { status: 'succeeded', providerRef: `mock_${reference}` };
  },
};
