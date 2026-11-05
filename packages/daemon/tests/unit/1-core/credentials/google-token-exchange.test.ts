import { beforeEach, expect, test } from 'bun:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { exchangeGoogleCode } from '../../../../src/lib/connections/google-token-exchange.ts';

const client = { clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret' };
const redirectUri = 'http://127.0.0.1:43111/oauth/google/callback';
const verifier = 'v'.repeat(43);
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let claims: Record<string, unknown>;
let signingKey: CryptoKey;
let token: Record<string, unknown>;
let requestBody: URLSearchParams;
beforeEach(async () => {
  key = await generateKeyPair('RS256');
  signingKey = key.privateKey;
  claims = {
    sub: 'subject-1',
    email: 'one@example.test',
    email_verified: true,
    nonce: 'synthetic-nonce',
    iss: 'https://accounts.google.com',
    aud: client.clientId,
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
  };
  token = {};
});

const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  if (String(url) === 'https://www.googleapis.com/oauth2/v3/certs')
    return Response.json({
      keys: [
        { ...(await exportJWK(key.publicKey)), kid: 'synthetic-key', use: 'sig', alg: 'RS256' },
      ],
    });
  expect(String(url)).toBe('https://oauth2.googleapis.com/token');
  expect(init?.method).toBe('POST');
  expect(init?.redirect).toBe('error');
  init?.signal?.throwIfAborted();
  requestBody = new URLSearchParams(String(init?.body));
  const id = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
    .sign(signingKey);
  return Response.json({
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    expires_in: 3600,
    scope: 'openid email',
    token_type: 'Bearer',
    id_token: id,
    ...token,
  });
}) as typeof fetch;

const exchange = (fetchImpl = fakeFetch, signal = new AbortController().signal) =>
  exchangeGoogleCode(
    'synthetic-code',
    verifier,
    redirectUri,
    'synthetic-nonce',
    client,
    fetchImpl,
    signal
  );

test('binds the exact code, verifier, redirect and client; returns only the verified account and actual grant', async () => {
  const before = Date.now();
  const result = await exchange();
  expect(Object.fromEntries(requestBody)).toEqual({
    grant_type: 'authorization_code',
    code: 'synthetic-code',
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  expect(result).toEqual({
    ok: true,
    accountId: 'subject-1',
    email: 'one@example.test',
    tokens: {
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      expiresAt: expect.any(Number),
      scopes: ['openid', 'email'],
    },
  });
  expect(result.tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600000);
  expect(JSON.stringify(result)).not.toContain('id_token');
});

test.each([
  { nonce: 'wrong' },
  { iss: 'https://wrong.example.test' },
  { aud: 'wrong-client' },
  { azp: 'wrong-client' },
  { email_verified: false },
  { exp: 1 },
  { exp: undefined },
  { sub: '' },
  { email: 'invalid' },
  { iat: undefined },
])('refuses incorrect identity %j', async (invalid) => {
  Object.assign(claims, invalid);
  await expect(exchange()).rejects.toThrow();
});

test('refuses a forged signature from a different key', async () => {
  signingKey = (await generateKeyPair('RS256')).privateKey;
  await expect(exchange()).rejects.toThrow();
});

test.each([{ expires_in: 0 }, { access_token: '' }, { token_type: 'wrong' }, { id_token: '' }])(
  'refuses malformed grants %j',
  async (invalid) => {
    token = invalid;
    await expect(exchange()).rejects.toThrow();
  }
);

test('handles missing refresh tokens without inventing a grant', async () => {
  token = { refresh_token: undefined, scope: 'openid' };
  expect((await exchange()).tokens).toMatchObject({ refreshToken: undefined, scopes: ['openid'] });
});

test('refuses HTTP errors without returning the remote body', async () => {
  const fail = (async () =>
    new Response('synthetic-secret-in-error', { status: 400 })) as typeof fetch;
  await expect(exchange(fail)).rejects.toThrow('Token exchange failed');
});

test('caps even chunked responses without a Content-Length header', async () => {
  let cancelled = false;
  const huge = (async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(40000));
        },
        cancel() {
          cancelled = true;
        },
      })
    )) as typeof fetch;
  await expect(exchange(huge)).rejects.toThrow('Token response too large');
  expect(cancelled).toBe(true);
});

test('cancellation interrupts an in-flight exchange', async () => {
  const control = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = (async (_url: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('synthetic aborted')), {
        once: true,
      });
      started();
    })) as typeof fetch;
  const result = exchange(pending, control.signal);
  await ready;
  control.abort();
  await expect(result).rejects.toThrow('synthetic aborted');
});
