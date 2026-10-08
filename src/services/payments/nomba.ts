import crypto from 'node:crypto';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { ServiceUnavailable } from '../../lib/errors.js';
import type { PaymentProvider, TransferResult } from './types.js';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface NombaEnvelope<T> {
  code?: string;
  description?: string;
  data?: T;
}

/** Thrown when Nomba answered with a non-2xx status. */
class NombaHttpError extends ServiceUnavailable {
  constructor(
    public readonly httpStatus: number,
    description: string,
  ) {
    super(`Nomba API error: ${description}`);
  }
}

let token: { accessToken: string; expiresAt: number } | null = null;
let tokenInFlight: Promise<string> | null = null;

async function apiPost<T>(path: string, body: unknown, useAuth = true): Promise<NombaEnvelope<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.NOMBA_ACCOUNT_ID) headers['accountId'] = env.NOMBA_ACCOUNT_ID;
  if (useAuth) headers['Authorization'] = `Bearer ${await getAccessToken()}`;

  const response = await fetch(`${env.NOMBA_BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const text = await response.text();
  let data: NombaEnvelope<T>;
  try {
    data = text ? (JSON.parse(text) as NombaEnvelope<T>) : {};
  } catch {
    data = { description: text.slice(0, 200) };
  }

  if (!response.ok) {
    logger.error({ path, status: response.status, description: data.description }, 'Nomba API error');
    throw new NombaHttpError(response.status, data.description ?? response.statusText);
  }
  return data;
}

async function issueToken(): Promise<string> {
  const res = await apiPost<{ access_token: string; expiresAt: string }>(
    '/v1/auth/token/issue',
    {
      grant_type: 'client_credentials',
      client_id: env.NOMBA_CLIENT_ID,
      client_secret: env.NOMBA_SECRET_KEY,
    },
    false,
  );
  if (res.code !== '00' || !res.data) {
    throw new ServiceUnavailable('Failed to obtain Nomba access token');
  }
  token = { accessToken: res.data.access_token, expiresAt: new Date(res.data.expiresAt).getTime() };
  return token.accessToken;
}

async function getAccessToken(): Promise<string> {
  if (token && token.expiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()) return token.accessToken;
  // Share one in-flight token request between concurrent callers.
  tokenInFlight ??= issueToken().finally(() => {
    tokenInFlight = null;
  });
  return tokenInFlight;
}

export const nombaProvider: PaymentProvider = {
  name: 'nomba',

  async createPayInAccount({ reference, accountName, amountNGN }) {
    const res = await apiPost<{
      bankAccountNumber: string;
      bankName: string;
      bankAccountName: string;
      accountRef: string;
    }>('/v1/accounts/virtual', { accountRef: reference, accountName, expectedAmount: amountNGN });

    if (res.code !== '00' || !res.data) {
      throw new ServiceUnavailable(`Failed to create pay-in account: ${res.description ?? 'unknown error'}`);
    }
    return {
      accountNumber: res.data.bankAccountNumber,
      bankName: res.data.bankName,
      accountName: res.data.bankAccountName,
      reference: res.data.accountRef,
    };
  },

  async resolveBankAccount({ accountNumber, bankCode }) {
    const res = await apiPost<{ accountNumber: string; accountName: string }>(
      '/v1/transfers/bank/lookup',
      { accountNumber, bankCode },
    );
    if (res.code !== '00' || !res.data?.accountName) {
      throw new ServiceUnavailable(`Bank account lookup failed: ${res.description ?? 'unknown error'}`);
    }
    return { accountName: res.data.accountName };
  },

  async transfer({ reference, amountNGN, bankCode, accountNumber, accountName, narration }): Promise<TransferResult> {
    let res: NombaEnvelope<{ status?: string; id?: string }>;
    try {
      res = await apiPost('/v2/transfers/bank', {
        amount: amountNGN,
        accountNumber,
        accountName,
        bankCode,
        merchantTxRef: reference,
        senderName: 'SafeSale',
        narration,
      });
    } catch (err) {
      // A 4xx is a definite rejection. Timeouts, network errors and 5xx
      // leave the outcome unknown — retry later with the same reference.
      if (err instanceof NombaHttpError && err.httpStatus >= 400 && err.httpStatus < 500) {
        return { status: 'failed', providerRef: null, message: err.message };
      }
      return { status: 'pending', providerRef: null, message: err instanceof Error ? err.message : String(err) };
    }

    const providerRef = res.data?.id ?? null;
    if (res.code !== '00') {
      return { status: 'failed', providerRef, message: res.description };
    }
    const status = (res.data?.status ?? '').toUpperCase();
    if (status === 'SUCCESS' || status === 'SUCCESSFUL') return { status: 'succeeded', providerRef };
    if (status.includes('FAIL') || status === 'REVERSED') {
      return { status: 'failed', providerRef, message: res.description };
    }
    return { status: 'pending', providerRef };
  },
};

/**
 * Verify a Nomba webhook signature. Fails closed: with no signing key
 * configured, every webhook is rejected.
 */
export function verifyNombaWebhookSignature(
  payload: Record<string, any>,
  signature: string,
  timestamp: string,
): boolean {
  if (!env.NOMBA_SIGNING_KEY) {
    logger.error('NOMBA_SIGNING_KEY is not set — rejecting webhook');
    return false;
  }

  const data = payload.data ?? {};
  const merchant = data.merchant ?? {};
  const transaction = data.transaction ?? {};
  const responseCode = transaction.responseCode === 'null' ? '' : (transaction.responseCode ?? '');

  const hashingPayload = [
    payload.event_type ?? '',
    payload.requestId ?? '',
    merchant.userId ?? '',
    merchant.walletId ?? '',
    transaction.transactionId ?? '',
    transaction.type ?? '',
    transaction.time ?? '',
    responseCode,
    timestamp,
  ].join(':');

  const expected = crypto.createHmac('sha256', env.NOMBA_SIGNING_KEY).update(hashingPayload).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
