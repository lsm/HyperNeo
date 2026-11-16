import { afterEach, beforeEach, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createTestDb } from '../../../helpers/database.ts';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store.ts';
import { ConnectionVault } from '../../../../src/lib/connections/vault.ts';
import { createGoogleConnectionOperations } from '../../../../src/lib/connections/operations.ts';
import { createMicrosoftConnectionOperations } from '../../../../src/lib/connections/microsoft-operations.ts';
import { createConnectionList } from '../../../../src/lib/connections/list-operation.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { artifactIdentityWrites } from '../../../../src/storage/repositories/artifact-file-identity-write.ts';
import { googleConnectionReads } from '../../../../src/storage/repositories/google-connections-worker.ts';
import type { ConnectionStatus } from '../../../../src/lib/connections/status.ts';

const login = 'https://login.microsoftonline.com';
const tenant = '11111111-2222-4333-8444-555555555555';
const otherTenant = '99999999-2222-4333-8444-555555555555';
const scopes = ['openid', 'profile', 'email', 'offline_access', 'Mail.ReadWrite', 'Calendars.Read'];
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (issuer: string) => ({
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'synthetic-key',
  use: 'sig',
  issuer,
});

let db: Awaited<ReturnType<typeof createTestDb>>;
let store: DatabaseCredentialStore;
let registry: ReturnType<typeof createOperationRegistry>;
let claims: Record<string, unknown>;
let keyIssuer: string;
let tokenForms: URLSearchParams[];
let external: string[];

function idToken(nonce: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-key' })).toString(
    'base64url'
  );
  const body = Buffer.from(
    JSON.stringify({
      iss: `${login}/${tenant}/v2.0`,
      aud: 'synthetic-microsoft-client',
      tid: tenant,
      oid: 'synthetic-object',
      sub: 'synthetic-pairwise-subject',
      email: 'one@example.test',
      nonce,
      iat: now,
      exp: now + 3600,
      ...claims,
    })
  ).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey);
  return `${header}.${body}.${signature.toString('base64url')}`;
}

const nonces = new Map<string, string>();
const fetchImpl = (async (url, init) => {
  const target = new URL(String(url));
  if (target.href === `${login}/common/discovery/v2.0/keys`)
    return Response.json({ keys: [jwk(keyIssuer)] });
  if (target.href === `${login}/common/oauth2/v2.0/token`) {
    const form = new URLSearchParams(String(init?.body));
    tokenForms.push(form);
    return Response.json({
      access_token: 'synthetic-microsoft-access',
      refresh_token: 'synthetic-microsoft-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'Mail.ReadWrite Calendars.Read openid profile email',
      id_token: idToken(nonces.get(form.get('code')!)!),
    });
  }
  external.push(target.href);
  return new Response('not found', { status: 404 });
}) as typeof fetch;

beforeEach(async () => {
  db = await createTestDb();
  store = new DatabaseCredentialStore(db.getDatabase(), 'synthetic-key');
  claims = {};
  keyIssuer = `${login}/{tenantid}/v2.0`;
  tokenForms = [];
  external = [];
  nonces.clear();
  const deps = { createStore: () => store, fetchImpl };
  registry = createOperationRegistry([
    ...createMicrosoftConnectionOperations(() => db.getDatabase(), deps),
    ...createGoogleConnectionOperations(() => db.getDatabase(), deps),
    createConnectionList(() => db.getDatabase()),
  ]);
});
afterEach(() => db.close());

type View = { state: string; loginId?: string; connectionId?: string; reason?: string };
async function call<T = View>(name: string, input: unknown): Promise<T> {
  const outcome = await invokeOperation(registry, name, input, {
    source: 'rpc',
    principal: 'local',
  });
  if (outcome.kind !== 'completed') throw new Error(outcome.message);
  return outcome.value as T;
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
async function settle(loginId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const view = await call('connections.microsoft.login', { loginId });
    if (view.state !== 'pending') return view;
    await pause();
  }
  throw new Error('Sign-in never settled');
}
async function begin(input: unknown = { clientId: 'synthetic-microsoft-client' }) {
  const start = await call<View & { authorizeUrl: string }>('connections.microsoft.connect', input);
  expect(start.state).toBe('pending');
  return { start, authorize: new URL(start.authorizeUrl) };
}
async function callback(authorize: URL, params: Record<string, string>, host?: string) {
  const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
  const target = new URL(redirect.pathname, `http://127.0.0.1:${redirect.port}`);
  target.search = new URLSearchParams(params).toString();
  const response = await fetch(target, { headers: { host: host ?? redirect.host } });
  return response.status;
}
async function consent(authorize: URL, code = `synthetic-code-${crypto.randomUUID()}`) {
  nonces.set(code, authorize.searchParams.get('nonce')!);
  return callback(authorize, { code, state: authorize.searchParams.get('state')! });
}
const rows = () => db.gateway.call(googleConnectionReads, 'list');
async function bundle(connection: ConnectionStatus) {
  const identity = await db.gateway.call(artifactIdentityWrites, 'ensure', 'unused');
  return new ConnectionVault(store, identity).read(connection);
}

test('Microsoft sign-in asks for the six scopes through a localhost PKCE redirect', async () => {
  const { authorize } = await begin();
  expect(authorize.origin + authorize.pathname).toBe(`${login}/common/oauth2/v2.0/authorize`);
  expect(authorize.searchParams.get('client_id')).toBe('synthetic-microsoft-client');
  expect(authorize.searchParams.get('response_type')).toBe('code');
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorize.searchParams.get('prompt')).toBe('select_account');
  expect(authorize.searchParams.get('scope')!.split(' ').sort()).toEqual([...scopes].sort());
  expect(authorize.searchParams.get('redirect_uri')).toMatch(
    /^http:\/\/localhost:\d+\/oauth\/microsoft\/callback$/
  );
});

test('a completed sign-in stores a Microsoft connection keyed by tenant and object id', async () => {
  const { start, authorize } = await begin();
  expect(await consent(authorize)).toBe(200);
  const done = await settle(start.loginId!);
  expect(done.state).toBe('complete');
  const [row] = await rows();
  expect(row).toMatchObject({
    id: done.connectionId,
    provider: 'microsoft',
    accountId: `${tenant}.synthetic-object`,
    email: 'one@example.test',
    health: 'healthy',
  });
  expect(await bundle(row)).toMatchObject({
    accessToken: 'synthetic-microsoft-access',
    refreshToken: 'synthetic-microsoft-refresh',
    client: { clientId: 'synthetic-microsoft-client' },
  });
  expect(tokenForms[0].get('code_verifier')).toBeTruthy();
  expect(tokenForms[0].get('client_secret')).toBeNull();
  expect(tokenForms[0].get('redirect_uri')).toBe(authorize.searchParams.get('redirect_uri'));
  expect(JSON.stringify(await call('connections.list', {}))).not.toContain('synthetic-microsoft');
  expect(external).toEqual([]);
});

test.each([
  ['a wrong nonce', () => ({ nonce: 'synthetic-other-nonce' })],
  ['a wrong audience', () => ({ aud: 'synthetic-other-client' })],
  ['a non-GUID tenant', () => ({ tid: 'not-a-guid', iss: `${login}/not-a-guid/v2.0` })],
  ['an issuer for another tenant', () => ({ iss: `${login}/${otherTenant}/v2.0` })],
])('sign-in with %s is refused and stores nothing', async (_name, change) => {
  claims = change();
  const { start, authorize } = await begin();
  await consent(authorize);
  expect(await settle(start.loginId!)).toMatchObject({ state: 'failed', reason: 'login_failed' });
  expect(await rows()).toEqual([]);
});

test('a token signed by a key restricted to another tenant is refused', async () => {
  keyIssuer = `${login}/${otherTenant}/v2.0`;
  const { start, authorize } = await begin();
  await consent(authorize);
  expect(await settle(start.loginId!)).toMatchObject({ state: 'failed', reason: 'login_failed' });
  expect(await rows()).toEqual([]);
});

test('an account without an email address is refused as unsupported', async () => {
  claims = { email: undefined, preferred_username: 'not-an-email' };
  const { start, authorize } = await begin();
  await consent(authorize);
  expect(await settle(start.loginId!)).toMatchObject({
    state: 'failed',
    reason: 'account_unsupported',
  });
  expect(await rows()).toEqual([]);
});

test('wrong state, wrong host and a replayed callback are refused', async () => {
  const { start, authorize } = await begin();
  const code = 'synthetic-code-once';
  nonces.set(code, authorize.searchParams.get('nonce')!);
  expect(await callback(authorize, { code, state: 'synthetic-wrong-state' })).toBe(400);
  const state = authorize.searchParams.get('state')!;
  expect(await callback(authorize, { code, state }, '127.0.0.1')).toBe(400);
  expect(tokenForms).toEqual([]);
  expect(await callback(authorize, { code, state })).toBe(200);
  expect((await settle(start.loginId!)).state).toBe('complete');
  expect(await callback(authorize, { code, state }).catch(() => 'closed')).not.toBe(200);
  expect(tokenForms).toHaveLength(1);
});

test('reconnect refuses another account and keeps the existing grant', async () => {
  const first = await begin();
  await consent(first.authorize);
  const done = await settle(first.start.loginId!);
  const [row] = await rows();
  claims = { oid: 'synthetic-other-object' };
  const again = await begin({ connectionId: done.connectionId });
  await consent(again.authorize);
  expect(await settle(again.start.loginId!)).toMatchObject({
    state: 'failed',
    reason: 'account_mismatch',
  });
  expect(await rows()).toEqual([row]);
  expect(await bundle(row)).toMatchObject({ accessToken: 'synthetic-microsoft-access' });
});

test('disconnect erases the Microsoft bundle and Google disconnect cannot touch it', async () => {
  const { start, authorize } = await begin();
  await consent(authorize);
  const done = await settle(start.loginId!);
  const [row] = await rows();
  expect(await call('connections.google.disconnect', { connectionId: done.connectionId })).toEqual({
    ok: false,
    reason: 'unknown_connection',
  });
  expect(await bundle(row)).not.toBeNull();
  expect(
    await call('connections.microsoft.disconnect', { connectionId: done.connectionId })
  ).toEqual({ ok: true });
  expect((await rows())[0].health).toBe('disconnected');
  expect(await bundle(row)).toBeNull();
});
