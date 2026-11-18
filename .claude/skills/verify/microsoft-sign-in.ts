import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { CredentialStore } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
mkdirSync(join(run, 'evidence'), { recursive: true });
const authority = 'https://login.microsoftonline.com';
const tenant = '11111111-2222-4333-8444-555555555555';
const otherTenant = '99999999-2222-4333-8444-555555555555';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
let keyIssuer = `${authority}/{tenantid}/v2.0`, oid = 'synthetic-object';
const nonces = new Map<string, string>();
const requests: string[] = [], observations: unknown[] = [];
const secrets = new Map<string, string>();
const store: CredentialStore = {
  get: async (service, account) => secrets.get(JSON.stringify([service, account])) ?? null,
  set: async (service, account, value) => { secrets.set(JSON.stringify([service, account]), value); },
  delete: async (service, account) => { secrets.delete(JSON.stringify([service, account])); },
  listServices: async (prefix) => [...new Set([...secrets.keys()].map((key) => JSON.parse(key)[0] as string).filter((service) => service.startsWith(prefix)))],
  getStatus: () => ({ backend: 'keychain', keychainAvailable: true }),
};
function idToken(nonce: string) {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${part({ alg: 'RS256', kid: 'synthetic-key' })}.${part({ iss: `${authority}/${tenant}/v2.0`, aud: 'synthetic-microsoft-client', tid: tenant, oid, email: 'one@example.test', nonce, iat: now, exp: now + 3600 })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), keys.privateKey).toString('base64url')}`;
}
const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
  const target = new URL(String(url));
  requests.push(`${init?.method ?? 'GET'} ${target.origin}${target.pathname}`);
  assert.equal(target.origin, authority, 'external network refused');
  if (target.pathname === '/common/discovery/v2.0/keys') return Response.json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', use: 'sig', issuer: keyIssuer }] });
  assert.equal(target.pathname, '/common/oauth2/v2.0/token');
  const form = new URLSearchParams(String(init?.body));
  assert.equal(form.get('grant_type'), 'authorization_code'); assert(form.get('code_verifier')); assert.equal(form.get('client_secret'), null);
  return Response.json({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', expires_in: 3600, token_type: 'Bearer', scope: 'Mail.ReadWrite Calendars.Read openid profile email', id_token: idToken(nonces.get(form.get('code')!)!) });
}) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data', 'daemon.db') }), verbose: false, googleConnections: { createStore: () => store, fetchImpl, schedule: () => () => {} } });
async function rpc(name: string, input: unknown = {}) {
  const ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  try {
    await new Promise<void>((done, fail) => { ws.onopen = () => done(); ws.onerror = () => fail(new Error('Isolated RPC unavailable')); });
    const value = await new Promise<ReturnType<typeof JSON.parse>>((done, fail) => {
      const id = crypto.randomUUID(), timeout = setTimeout(() => fail(new Error('Management RPC timed out')), 10000);
      ws.onmessage = (event) => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timeout); reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.data); };
      ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
    const text = JSON.stringify(value);
    for (const secret of ['synthetic-access-token', 'synthetic-refresh-token', 'id_token']) assert(!text.includes(secret), `credential disclosure in ${name}`);
    observations.push({ name, value }); return value;
  } finally { ws.close(); }
}
async function signIn(input: unknown) {
  const flow = await rpc('connections.microsoft.connect', input);
  assert.equal(flow.state, 'pending');
  const authorize = new URL(flow.authorizeUrl);
  assert.equal(`${authorize.origin}${authorize.pathname}`, `${authority}/common/oauth2/v2.0/authorize`);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256'); assert.equal(authorize.searchParams.get('prompt'), 'select_account');
  assert.deepEqual(authorize.searchParams.get('scope')!.split(' ').sort(), ['Calendars.Read', 'Mail.ReadWrite', 'email', 'offline_access', 'openid', 'profile']);
  const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
  assert.equal(redirect.hostname, 'localhost'); assert.equal(redirect.pathname, '/oauth/microsoft/callback');
  const code = `synthetic-code-${crypto.randomUUID()}`; nonces.set(code, authorize.searchParams.get('nonce')!);
  redirect.search = new URLSearchParams({ code, state: authorize.searchParams.get('state')! }).toString();
  const status = await new Promise<number>((done, fail) => {
    const call = request({ hostname: '::1', port: redirect.port, path: redirect.pathname + redirect.search, headers: { host: redirect.host } }, (response) => {
      response.resume(); response.on('end', () => done(response.statusCode ?? 0));
    });
    call.on('error', fail); call.end();
  });
  assert([200, 400].includes(status));
  for (const deadline = Date.now() + 10000; ; await new Promise((done) => setTimeout(done, 10))) {
    const view = await rpc('connections.microsoft.login', { loginId: flow.loginId });
    if (view.state !== 'pending') return view;
    assert(Date.now() < deadline, 'sign-in did not settle');
  }
}
try {
  const done = await signIn({ clientId: 'synthetic-microsoft-client' });
  assert.equal(done.state, 'complete'); assert.equal(secrets.size, 1);
  const [row] = (await rpc('connections.list')).connections;
  assert.deepEqual({ provider: row.provider, accountId: row.accountId, email: row.email, health: row.health }, { provider: 'microsoft', accountId: `${tenant}.synthetic-object`, email: 'one@example.test', health: 'healthy' });
  keyIssuer = `${authority}/${otherTenant}/v2.0`;
  assert.deepEqual(await signIn({ clientId: 'synthetic-microsoft-client' }), { state: 'failed', reason: 'login_failed', storage: done.storage });
  keyIssuer = `${authority}/{tenantid}/v2.0`; oid = 'synthetic-other-object';
  assert.equal((await signIn({ connectionId: done.connectionId })).reason, 'account_mismatch');
  assert.equal((await rpc('connections.list')).connections.length, 1); assert.equal(secrets.size, 1);
  assert.deepEqual(await rpc('connections.google.disconnect', { connectionId: done.connectionId }), { ok: false, reason: 'unknown_connection' }); assert.equal(secrets.size, 1);
  assert.deepEqual(await rpc('connections.microsoft.disconnect', { connectionId: done.connectionId }), { ok: true });
  assert.equal(secrets.size, 0); assert.equal((await rpc('connections.list')).connections[0].health, 'disconnected');
  console.log('PASS: Microsoft sign-in, key-issuer refusal, account mismatch and disconnect through real RPC; no credentials in replies');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/microsoft-sign-in.json'), JSON.stringify({ runtime: process.versions, observations, requests, remainingCredentials: secrets.size }, null, 2));
}
