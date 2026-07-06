import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { ServiceUnavailable } from '../lib/errors.js';
import crypto from 'node:crypto';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

interface TokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

let tokenState: TokenState | null = null;
let tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;

async function apiPost<T>(path: string, body: unknown, useAuth = true): Promise<T> {
  const url = `${env.NOMBA_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (env.NOMBA_ACCOUNT_ID) {
    headers['accountId'] = env.NOMBA_ACCOUNT_ID;
  }

  if (useAuth) {
    const token = await getAccessToken();
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const desc = typeof data?.description === 'string' ? data.description : response.statusText;
    logger.error({ path, status: response.status, data }, 'Nomba API error');
    throw new ServiceUnavailable(`Nomba API error: ${desc}`);
  }

  return data as T;
}

// apiGet will be added when needed for account balance lookups

async function obtainAccessToken(): Promise<TokenState> {
  const response = await apiPost<{
    code: string;
    description: string;
    data: {
      access_token: string;
      refresh_token: string;
      expiresAt: string;
    };
  }>('/v1/auth/token/issue', {
    grant_type: 'client_credentials',
    client_id: env.NOMBA_CLIENT_ID,
    client_secret: env.NOMBA_SECRET_KEY,
  }, false);

  if (response.code !== '00' || !response.data) {
    throw new ServiceUnavailable('Failed to obtain Nomba access token');
  }

  return {
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token,
    expiresAt: new Date(response.data.expiresAt),
  };
}

async function refreshAccessToken(refreshToken: string): Promise<TokenState> {
  const accessToken = tokenState?.accessToken;
  if (!accessToken) {
    return obtainAccessToken();
  }

  const response = await apiPost<{
    code: string;
    description: string;
    data: {
      access_token: string;
      refresh_token: string;
      expiresAt: string;
    };
  }>('/v1/auth/token/refresh', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  if (response.code !== '00' || !response.data) {
    return obtainAccessToken();
  }

  return {
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token,
    expiresAt: new Date(response.data.expiresAt),
  };
}

function scheduleTokenRefresh(expiresAt: Date) {
  if (tokenRefreshTimer) {
    clearTimeout(tokenRefreshTimer);
  }

  const now = Date.now();
  const expiry = expiresAt.getTime();
  const refreshIn = Math.max(0, expiry - now - TOKEN_REFRESH_BUFFER_MS);

  tokenRefreshTimer = setTimeout(async () => {
    try {
      if (tokenState) {
        tokenState = await refreshAccessToken(tokenState.refreshToken);
        scheduleTokenRefresh(tokenState.expiresAt);
      }
    } catch (err) {
      logger.error({ err }, 'Nomba token refresh failed, will retry in 60s');
      tokenRefreshTimer = setTimeout(() => {
        if (tokenState) {
          scheduleTokenRefresh(new Date(Date.now() + 60000));
        }
      }, 60000);
    }
  }, refreshIn);
}

async function getAccessToken(): Promise<string> {
  if (!tokenState || tokenState.expiresAt.getTime() - TOKEN_REFRESH_BUFFER_MS <= Date.now()) {
    tokenState = await obtainAccessToken();
    scheduleTokenRefresh(tokenState.expiresAt);
  }
  return tokenState.accessToken;
}

export interface CreateVirtualAccountParams {
  accountRef: string;
  accountName: string;
  expectedAmount?: number;
  expiryDate?: string;
}

export interface VirtualAccountResult {
  accountNumber: string;
  bankName: string;
  accountName: string;
  accountRef: string;
}

export async function createVirtualAccount(params: CreateVirtualAccountParams): Promise<VirtualAccountResult> {
  const response = await apiPost<{
    code: string;
    description: string;
    data: {
      bankAccountNumber: string;
      bankName: string;
      bankAccountName: string;
      accountRef: string;
    };
  }>('/v1/accounts/virtual', {
    accountRef: params.accountRef,
    accountName: params.accountName,
    ...(params.expectedAmount !== undefined && { expectedAmount: params.expectedAmount }),
    ...(params.expiryDate && { expiryDate: params.expiryDate }),
  });

  if (response.code !== '00' || !response.data) {
    throw new ServiceUnavailable(`Failed to create virtual account: ${response.description}`);
  }

  return {
    accountNumber: response.data.bankAccountNumber,
    bankName: response.data.bankName,
    accountName: response.data.bankAccountName,
    accountRef: response.data.accountRef,
  };
}

export interface BankLookupParams {
  accountNumber: string;
  bankCode: string;
}

export interface BankLookupResult {
  accountNumber: string;
  accountName: string;
}

export async function bankAccountLookup(params: BankLookupParams): Promise<BankLookupResult> {
  const response = await apiPost<{
    code: string;
    description: string;
    data: {
      accountNumber: string;
      accountName: string;
    };
  }>('/v1/transfers/bank/lookup', {
    accountNumber: params.accountNumber,
    bankCode: params.bankCode,
  });

  if (response.code !== '00' || !response.data) {
    throw new ServiceUnavailable(`Bank lookup failed: ${response.description}`);
  }

  return {
    accountNumber: response.data.accountNumber,
    accountName: response.data.accountName,
  };
}

export interface BankTransferParams {
  amount: number;
  accountNumber: string;
  accountName: string;
  bankCode: string;
  merchantTxRef: string;
  narration?: string;
}

export interface BankTransferResult {
  status: string;
  transactionId: string;
}

export async function transferToBank(params: BankTransferParams): Promise<BankTransferResult> {
  const response = await apiPost<{
    code: string;
    description: string;
    data: {
      status: string;
      id: string;
    };
  }>('/v2/transfers/bank', {
    amount: params.amount,
    accountNumber: params.accountNumber,
    accountName: params.accountName,
    bankCode: params.bankCode,
    merchantTxRef: params.merchantTxRef,
    ...(params.narration && { narration: params.narration }),
  });

  return {
    status: response.data?.status || response.description,
    transactionId: response.data?.id || '',
  };
}

export function verifyWebhookSignature(
  body: string,
  signature: string,
  timestamp: string,
): boolean {
  if (!env.NOMBA_SIGNING_KEY) {
    logger.warn('Nomba webhook signing key not configured — skipping signature verification');
    return true;
  }

  try {
    const payload = JSON.parse(body);
    const data = payload.data || {};
    const merchant = data.merchant || {};
    const transaction = data.transaction || {};

    const eventType = payload.event_type || '';
    const requestId = payload.requestId || '';
    const userId = merchant.userId || '';
    const walletId = merchant.walletId || '';
    const transactionId = transaction.transactionId || '';
    const transactionType = transaction.type || '';
    const transactionTime = transaction.time || '';
    let transactionResponseCode = transaction.responseCode || '';

    if (transactionResponseCode === 'null') {
      transactionResponseCode = '';
    }

    const hashingPayload = `${eventType}:${requestId}:${userId}:${walletId}:${transactionId}:${transactionType}:${transactionTime}:${transactionResponseCode}:${timestamp}`;

    const hmac = crypto.createHmac('sha256', env.NOMBA_SIGNING_KEY);
    hmac.update(hashingPayload);
    const expected = hmac.digest('base64');

    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (err) {
    logger.error({ err }, 'Webhook signature verification failed');
    return false;
  }
}
