import { env } from '../../env.js';
import { mockProvider } from './mock.js';
import { nombaProvider } from './nomba.js';
import type { PaymentProvider } from './types.js';

export type { PaymentProvider, PayInAccount, TransferRequest, TransferResult } from './types.js';

export const payments: PaymentProvider = env.PAYMENT_PROVIDER === 'nomba' ? nombaProvider : mockProvider;
