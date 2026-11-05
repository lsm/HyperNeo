import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createHttpWsServer } from '../../../packages/daemon/src/lib/runtime-server/index.ts';
import { exchangeGoogleCode } from '../../../packages/daemon/src/lib/connections/google-token-exchange.ts';

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
const evidence: unknown[] = [];
let claims: Record<string, unknown> = {};
const client = { clientId: 'synthetic-client' };
const redirect = 'http://127.0.0.1:43111/oauth/google/callback';
const nonce = 'synthetic-nonce';
const verifier = 'v'.repeat(43);
const fake = await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
  const path = new URL(request.url).pathname;
  if (path === '/certs') return Response.json({ keys: [jwk] });
  assert.equal(path, '/token');
  assert.equal(request.method, 'POST');
  const input = new URLSearchParams(await request.text());
  assert.deepEqual(Object.fromEntries(input), { grant_type: 'authorization_code', code: 'synthetic-code', code_verifier: verifier, redirect_uri: redirect, client_id: client.clientId });
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'synthetic-subject', email: 'one@example.test', email_verified: true, nonce, iss: 'https://accounts.google.com', aud: client.clientId, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), ...claims })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), pair.privateKey).toString('base64url')}`;
  evidence.push({ path, requestBindingVerified: true });
  return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, scope: 'openid email', token_type: 'Bearer', id_token: jwt });
} });
assert.notEqual(fake.port, 8399);
const fetchImpl = ((url: string | URL, init?: RequestInit) => {
  const routes: Record<string, string> = { 'https://oauth2.googleapis.com/token': '/token', 'https://www.googleapis.com/oauth2/v3/certs': '/certs' };
  const path = routes[String(url)];
  assert(path, 'external network refused');
  return fetch(`http://127.0.0.1:${fake.port}${path}`, init);
}) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const exchange = () => exchangeGoogleCode('synthetic-code', verifier, redirect, nonce, client, fetchImpl, new AbortController().signal);
  const result = await exchange();
  assert.equal(result.accountId, 'synthetic-subject');
  assert.deepEqual(result.tokens.scopes, ['openid', 'email']);
  assert.equal(result.tokens.accessToken, 'synthetic-access');
  evidence.push({ verifiedAccount: result.accountId, actualScopes: result.tokens.scopes, idTokenDiscarded: !('idToken' in result) });
  for (const [name, invalid] of Object.entries({ issuer: { iss: 'wrong' }, audience: { aud: 'wrong' }, nonce: { nonce: 'wrong' }, expired: { exp: 1 }, authorizedParty: { azp: 'wrong' }, verifiedEmail: { email_verified: false } })) {
    claims = invalid;
    await assert.rejects(exchange());
    evidence.push({ case: name, rejected: true });
  }
} finally { fake.stop(true); await app?.cleanup(); }
const text = JSON.stringify({ surface: 'token exchange primitive in isolated test-daemon process, actual HTTP fake Google token/JWKS endpoints; no public login operation yet', evidence, resourcesClosed: true }, null, 2);
assert(!text.includes('synthetic-access') && !text.includes('synthetic-refresh'));
writeFileSync(join(run, 'evidence/google-token-exchange.json'), text);
console.log('PASS: actual HTTP code exchange and signed JWKS verification; six invalid identity cases refused; resources closed');
