import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { api, prisma } from './helpers.js';

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubGoogleTokenInfo(info: Record<string, unknown>, ok = true) {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      return new Response(JSON.stringify(info), { status: ok ? 200 : 400 });
    }
    return realFetch(input, init);
  });
}

describe('google sign-in', () => {
  it('rejects the old unverified { email, googleId } body', async () => {
    const res = await api('POST', '/api/auth/google', { body: { email: 'victim@example.com', googleId: '123' } });
    expect(res.status).toBe(422);
  });

  it('rejects tokens issued to another app', async () => {
    stubGoogleTokenInfo({ aud: 'someone-else.apps.googleusercontent.com', sub: '1', email: 'a@example.com', email_verified: 'true' });
    const res = await api('POST', '/api/auth/google', { body: { accessToken: 'ya29.fake-token-value' } });
    expect(res.status).toBe(401);
  });

  it('rejects unverified Google emails', async () => {
    stubGoogleTokenInfo({ aud: 'safesale-test-client.apps.googleusercontent.com', sub: '2', email: 'b@example.com', email_verified: 'false' });
    const res = await api('POST', '/api/auth/google', { body: { accessToken: 'ya29.fake-token-value' } });
    expect(res.status).toBe(401);
  });

  it('signs in with a valid token and returns the same user next time', async () => {
    const info = { aud: 'safesale-test-client.apps.googleusercontent.com', sub: 'g-3', email: 'Ngozi@Example.com', email_verified: 'true' };
    stubGoogleTokenInfo(info);
    const first = await api('POST', '/api/auth/google', { body: { accessToken: 'ya29.fake-token-value' } });
    const second = await api('POST', '/api/auth/google', { body: { accessToken: 'ya29.fake-token-value' } });
    expect(first.status).toBe(200);
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(first.body.user.email).toBe('ngozi@example.com');
  });
});

describe('sessions', () => {
  it('rejects tokens signed with a different algorithm or secret', async () => {
    const forged = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') +
      '.' + Buffer.from(JSON.stringify({ sub: 'x', email: 'x@example.com', role: 'MEDIATOR' })).toString('base64url') + '.';
    expect((await api('GET', '/api/admin/disputes', { token: forged })).status).toBe(401);
  });
});

describe('webhooks', () => {
  it('rejects unsigned payment webhooks', async () => {
    const res = await api('POST', '/api/webhooks/nomba', {
      body: { event_type: 'payment_success', requestId: 'r1', data: { transaction: { aliasAccountReference: 'x', transactionAmount: 999999 } } },
    });
    expect(res.status).toBe(401);
  });
});
