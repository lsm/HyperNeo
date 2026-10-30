import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createHttpWsServer } from '../../../packages/daemon/src/lib/runtime-server/index.ts';
import { startGoogleLogin } from '../../../packages/daemon/src/lib/connections/google-login.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
let authorization: URLSearchParams;
let exchanges = 0;
const evidence: unknown[] = [];
const fake = await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
  const url = new URL(request.url);
  if (url.pathname === '/certs') return Response.json({ keys: [jwk] });
  if (url.pathname === '/authorize') {
    authorization = url.searchParams;
    assert.equal(authorization.get('code_challenge_method'), 'S256');
    assert.equal(authorization.get('access_type'), 'offline');
    const callback = new URL(authorization.get('redirect_uri')!);
    assert.equal(callback.hostname, '127.0.0.1');
    assert.notEqual(callback.port, '8399');
    callback.search = new URLSearchParams({ code: 'synthetic-code', state: authorization.get('state')! }).toString();
    return Response.redirect(callback.toString(), 302);
  }
  assert.equal(url.pathname, '/token');
  exchanges++;
  const form = new URLSearchParams(await request.text());
  assert.equal(form.get('redirect_uri'), authorization.get('redirect_uri'));
  assert.equal(form.get('client_id'), authorization.get('client_id'));
  assert.equal(form.get('code'), 'synthetic-code');
  assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), authorization.get('code_challenge'));
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'synthetic-subject', email: 'one@example.test', email_verified: true, nonce: authorization.get('nonce'), iss: 'https://accounts.google.com', aud: authorization.get('client_id'), exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, scope: 'openid email', token_type: 'Bearer', id_token: `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), pair.privateKey).toString('base64url')}` });
} });
assert.notEqual(fake.port, 8399);
const origin = `http://127.0.0.1:${fake.port}`;
const fetchImpl = ((url: string | URL, init?: RequestInit) => {
  const routes: Record<string, string> = { 'https://oauth2.googleapis.com/token': '/token', 'https://www.googleapis.com/oauth2/v3/certs': '/certs' };
  assert(routes[String(url)], 'external network refused');
  return fetch(`${origin}${routes[String(url)]}`, init);
}) as typeof fetch;
const sessions: Awaited<ReturnType<typeof startGoogleLogin>>[] = [];
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const begin = async (timeoutMs = 30000) => {
    const session = await startGoogleLogin({ clientId: 'synthetic-client' }, { fetchImpl, timeoutMs });
    sessions.push(session);
    return session;
  };
  const session = await begin();
  const authorize = new URL(session.authorizeUrl);
  const consent = await fetch(`${origin}/authorize?${authorize.searchParams}`, { redirect: 'manual' });
  const callback = new URL(consent.headers.get('location')!);
  const wrong = new URL(callback); wrong.searchParams.set('state', 'wrong');
  assert.equal((await fetch(wrong)).status, 400);
  wrong.pathname = '/wrong';
  assert.equal((await fetch(wrong)).status, 400);
  assert.equal((await fetch(callback, { method: 'POST' })).status, 400);
  const wrongHost = await new Promise<number>((done, fail) => {
    const call = httpRequest({ hostname: callback.hostname, port: callback.port, path: callback.pathname + callback.search, headers: { host: 'wrong.example.test' } }, (response) => {
      response.resume(); response.on('end', () => done(response.statusCode!));
    });
    call.setTimeout(5000, () => call.destroy(new Error('wrong-Host probe timed out')));
    call.on('error', fail); call.end();
  });
  assert.equal(wrongHost, 400);
  assert.equal(exchanges, 0);
  const replies = await Promise.allSettled([fetch(callback), fetch(callback)]);
  assert.equal(replies.filter((reply) => reply.status === 'fulfilled' && reply.value.status === 200).length, 1);
  const result = await session.result;
  assert(result.ok && result.accountId === 'synthetic-subject');
  assert.equal(exchanges, 1);
  for (const reply of replies) if (reply.status === 'fulfilled') assert(!(await reply.value.text()).includes('synthetic-access'));
  evidence.push({ consentRoundTrip: true, wrongCallbacksRefused: 4, replayExchanges: exchanges, signedAccount: result.accountId });
  const expired = await begin(10);
  assert.deepEqual(await expired.result, { ok: false, reason: 'expired' });
  const cancelled = await begin(); cancelled.cancel(); cancelled.cancel();
  assert.deepEqual(await cancelled.result, { ok: false, reason: 'cancelled' });
  const denied = await begin();
  const deniedUrl = new URL(denied.authorizeUrl);
  const deniedCallback = new URL(deniedUrl.searchParams.get('redirect_uri')!);
  deniedCallback.search = new URLSearchParams({ state: deniedUrl.searchParams.get('state')!, error: 'access_denied' }).toString();
  assert.equal((await fetch(deniedCallback)).status, 400);
  assert.deepEqual(await denied.result, { ok: false, reason: 'login_failed' });
  assert.equal(exchanges, 1);
  evidence.push({ expiry: true, cancellation: true, denial: true, extraTokenExchanges: 0 });
} finally { for (const session of sessions) session.cancel(); fake.stop(true); await app?.cleanup(); }
writeFileSync(join(run, 'evidence/google-loopback.json'), JSON.stringify({ surface: 'actual fake consent HTTP redirect, loopback callback and token/JWKS endpoints in an isolated test-daemon process; login operations/UI remain later', evidence, resourcesClosed: true }, null, 2));
console.log('PASS: fake consent redirect, PKCE binding, one exchange under replay, wrong callbacks, expiry/cancellation/denial; resources closed');
