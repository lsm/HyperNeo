import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { startGoogleLogin } from '../../../../src/lib/connections/google-login.ts';

let key: Awaited<ReturnType<typeof generateKeyPair>>;
let nonce = '';
let challenge = '';
let calls = 0;
let claims: Record<string, unknown>;
let sessions: Awaited<ReturnType<typeof startGoogleLogin>>[];
beforeEach(async () => {
  key = await generateKeyPair('RS256');
  calls = 0;
  sessions = [];
  claims = {};
});
afterEach(() => {
  for (const session of sessions) session.cancel();
});

const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  if (String(url) === 'https://www.googleapis.com/oauth2/v3/certs') {
    return Response.json({
      keys: [
        { ...(await exportJWK(key.publicKey)), kid: 'synthetic-key', alg: 'RS256', use: 'sig' },
      ],
    });
  }
  expect(String(url)).toBe('https://oauth2.googleapis.com/token');
  calls++;
  const form = new URLSearchParams(String(init?.body));
  expect(form.get('grant_type')).toBe('authorization_code');
  expect(form.get('client_id')).toBe('synthetic-client');
  expect(form.get('code')).toBe('synthetic-code');
  expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(
    challenge
  );
  const idToken = await new SignJWT({
    nonce,
    email: 'one@example.test',
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
    .setIssuer('https://accounts.google.com')
    .setAudience('synthetic-client')
    .setSubject('synthetic-subject')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key.privateKey);
  return Response.json({
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'openid email',
    id_token: idToken,
  });
}) as typeof fetch;

async function begin(timeoutMs = 30000) {
  const session = await startGoogleLogin(
    { clientId: 'synthetic-client' },
    { fetchImpl: fakeFetch, timeoutMs }
  );
  sessions.push(session);
  const url = new URL(session.authorizeUrl);
  nonce = url.searchParams.get('nonce')!;
  challenge = url.searchParams.get('code_challenge')!;
  return { session, url, callback: new URL(url.searchParams.get('redirect_uri')!) };
}

function callback(url: URL, state: string) {
  const copy = new URL(url);
  copy.search = new URLSearchParams({ code: 'synthetic-code', state }).toString();
  return copy;
}

test('uses loopback PKCE and only phase-1 scopes, then validates a signed identity', async () => {
  const { session, url, callback: redirect } = await begin();
  expect(redirect.hostname).toBe('127.0.0.1');
  expect(Number(redirect.port)).not.toBe(8399);
  expect(url.searchParams.get('access_type')).toBe('offline');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('scope')?.split(' ')).toEqual([
    'openid',
    'email',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
  ]);
  const response = await fetch(callback(redirect, url.searchParams.get('state')!));
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain('Authorization received');
  expect(text).not.toContain('synthetic-access');
  expect(await session.result).toMatchObject({
    ok: true,
    accountId: 'synthetic-subject',
    email: 'one@example.test',
    tokens: { accessToken: 'synthetic-access', scopes: ['openid', 'email'] },
  });
  expect(calls).toBe(1);
});

test('wrong path, method and state cannot consume consent or call the token endpoint', async () => {
  const { session, url, callback: redirect } = await begin();
  const wrong = new URL(redirect);
  wrong.pathname = '/wrong';
  expect((await fetch(wrong)).status).toBe(400);
  expect((await fetch(redirect, { method: 'POST' })).status).toBe(400);
  expect((await fetch(redirect, { headers: { host: 'wrong.example.test' } })).status).toBe(400);
  expect((await fetch(callback(redirect, 'wrong'))).status).toBe(400);
  expect(calls).toBe(0);
  expect((await fetch(callback(redirect, url.searchParams.get('state')!))).status).toBe(200);
  expect((await session.result).ok).toBe(true);
});

test('duplicate concurrent callbacks exchange at most once', async () => {
  const { session, url, callback: redirect } = await begin();
  const request = callback(redirect, url.searchParams.get('state')!);
  const replies = await Promise.allSettled([fetch(request), fetch(request)]);
  expect(replies.filter((r) => r.status === 'fulfilled' && r.value.status === 200)).toHaveLength(1);
  expect((await session.result).ok).toBe(true);
  expect(calls).toBe(1);
});

test('expiry closes the listener without exchanging or leaking a pending promise', async () => {
  const { session } = await begin(10);
  expect(await session.result).toEqual({ ok: false, reason: 'expired' });
  expect(calls).toBe(0);
});

test('cancellation closes the listener and returns one stable outcome', async () => {
  const { session } = await begin();
  session.cancel();
  session.cancel();
  expect(await session.result).toEqual({ ok: false, reason: 'cancelled' });
  expect(calls).toBe(0);
});

test.each([{ nonce: 'wrong' }, { email_verified: false }, { azp: 'wrong-client' }])(
  'rejects mismatched identity claims %j',
  async (invalid) => {
    claims = invalid;
    const { session, url, callback: redirect } = await begin();
    expect((await fetch(callback(redirect, url.searchParams.get('state')!))).status).toBe(400);
    expect(await session.result).toEqual({ ok: false, reason: 'login_failed' });
  }
);
