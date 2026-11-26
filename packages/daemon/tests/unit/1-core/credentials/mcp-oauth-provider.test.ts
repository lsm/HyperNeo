import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { runMigration467 } from '../../../../src/storage/schema/m467-google-connections.ts';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store.ts';
import { ConnectionVault } from '../../../../src/lib/connections/vault.ts';
import { createMcpOAuthProvider } from '../../../../src/lib/connections/mcp-oauth-provider.ts';
import type { McpOAuthPreset } from '../../../../src/lib/connections/mcp-fetch.ts';
import { startFakeMcpOAuthServer } from '../../../helpers/fake-mcp-oauth-server.ts';

type Fake = Awaited<ReturnType<typeof startFakeMcpOAuthServer>>;

let db: Database;
let store: DatabaseCredentialStore;
let vault: ConnectionVault;
let fake: Fake;
let other: Fake;

const presetFor = (server: Fake, extra: Partial<McpOAuthPreset> = {}): McpOAuthPreset => ({
  url: server.url,
  issuer: server.base,
  authorizationEndpoint: `${server.base}/authorize`,
  origins: [server.base],
  scopes: ['read', 'search'],
  ...extra,
});

function start(preset: McpOAuthPreset, onAuthorize?: (url: URL) => void) {
  return createMcpOAuthProvider({
    vault,
    serverId: 'server-1',
    preset,
    generation: 1,
    redirectUrl: 'http://127.0.0.1:9/callback',
    attempt: { authorize: onAuthorize ?? (() => {}) },
  });
}

function reuse(preset: McpOAuthPreset, target = vault) {
  return createMcpOAuthProvider({
    vault: target,
    serverId: 'server-1',
    preset,
    generation: 1,
    redirectUrl: 'http://127.0.0.1:9/callback',
  });
}

async function connect(preset = presetFor(fake)) {
  let consent: URL | undefined;
  const attempt = start(preset, (url) => {
    consent = url;
  });
  const options = { serverUrl: preset.url, scope: preset.scopes.join(' '), fetchFn: attempt.fetch };
  expect(await auth(attempt.provider, options)).toBe('REDIRECT');
  if (!consent) throw new Error('no consent URL');
  const answer = await fetch(consent, { redirect: 'manual' });
  const code = new URL(answer.headers.get('location') ?? '').searchParams.get('code') ?? '';
  expect(await auth(attempt.provider, { ...options, authorizationCode: code })).toBe('AUTHORIZED');
  await attempt.commit();
}

async function attemptUrl(preset: McpOAuthPreset, extra: { resourceMetadataUrl?: URL } = {}) {
  let consent: URL | undefined;
  const attempt = start(preset, (url) => {
    consent = url;
  });
  const outcome = await auth(attempt.provider, {
    serverUrl: preset.url,
    scope: preset.scopes.join(' '),
    fetchFn: attempt.fetch,
    ...extra,
  }).catch((error: Error) => error.message);
  return { outcome, consent };
}

const everyRow = () =>
  JSON.stringify(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all())
  );

beforeEach(async () => {
  db = new Database(':memory:');
  runMigration467(db);
  store = new DatabaseCredentialStore(db, 'synthetic-encryption-key');
  vault = new ConnectionVault(store, 'instance-1');
  fake = await startFakeMcpOAuthServer();
  other = await startFakeMcpOAuthServer();
});
afterEach(() => {
  fake.stop();
  other.stop();
  db.close();
});

describe('MCP OAuth provider', () => {
  test('connect runs discovery, DCR and PKCE and keeps the grant only in the vault', async () => {
    await connect();
    expect(fake.requests.map((request) => request.path)).toContain('/register');
    const grant = await vault.readMcp('server-1');
    expect(grant?.scopes).toEqual(['read', 'search']);
    const access = grant?.tokens.access_token ?? '';
    expect(access).toStartWith('access-');
    expect(everyRow()).not.toContain(access);

    const restarted = new ConnectionVault(
      new DatabaseCredentialStore(db, 'synthetic-encryption-key'),
      'instance-1'
    );
    expect((await reuse(presetFor(fake), restarted).provider.tokens())?.access_token).toBe(access);
    expect(await new ConnectionVault(store, 'instance-2').readMcp('server-1')).toBeNull();
    expect(await vault.readMcp('server-2')).toBeNull();
  });

  test('the authorize request carries only the preset maximum when every scope is advertised', async () => {
    fake.switches.advertiseAllScopes = true;
    await connect();
    expect(fake.authorizeScopes).toEqual(['read search']);
  });

  test('a grant wider than the maximum is not stored, also in the Slack reply shape', async () => {
    fake.switches.grantScope = 'read search write';
    await expect(connect()).rejects.toThrow('request_failed');
    fake.switches.slack = true;
    await expect(connect(presetFor(fake, { slackTokens: true }))).rejects.toThrow('request_failed');
    expect(await vault.readMcp('server-1')).toBeNull();
  });

  test('a Slack-shaped grant within the maximum is stored with its comma-separated scopes', async () => {
    fake.switches.slack = true;
    await connect(presetFor(fake, { slackTokens: true }));
    expect((await vault.readMcp('server-1'))?.scopes).toEqual(['read', 'search']);
  });

  test('a Slack ok:false reply fails the login', async () => {
    fake.switches.slackError = 'invalid_code';
    await expect(connect(presetFor(fake, { slackTokens: true }))).rejects.toThrow();
    expect(await vault.readMcp('server-1')).toBeNull();
  });

  test('a 401 pointing at another authorization server sends it nothing', async () => {
    await connect();
    const elsewhere = new URL(`${other.base}/.well-known/oauth-protected-resource/mcp`);
    const existing = reuse(presetFor(fake));
    await auth(existing.provider, {
      serverUrl: fake.url,
      scope: 'read search',
      resourceMetadataUrl: elsewhere,
      fetchFn: existing.fetch,
    });
    const { consent } = await attemptUrl(presetFor(fake), { resourceMetadataUrl: elsewhere });
    expect(consent?.origin).toBe(fake.base);
    expect(other.requests).toEqual([]);
  });

  test('metadata or a redirect naming an unpinned origin sends no request there', async () => {
    fake.switches.authorizationServer = other.base;
    expect((await attemptUrl(presetFor(fake))).consent).toBeUndefined();
    fake.switches.authorizationServer = undefined;
    fake.switches.redirectMetadataTo = `${other.base}/.well-known/oauth-protected-resource/mcp`;
    expect((await attemptUrl(presetFor(fake))).consent?.origin).toBe(fake.base);
    expect(other.requests).toEqual([]);
  });

  test('an authorization endpoint on an unapproved origin gives no authorize URL', async () => {
    fake.switches.authorizationEndpoint = `${other.base}/authorize`;
    expect(await attemptUrl(presetFor(fake))).toEqual({
      outcome: 'request_failed',
      consent: undefined,
    });
    expect(other.requests).toEqual([]);
  });

  test('metadata whose issuer is not the preset issuer is refused', async () => {
    fake.switches.metadataIssuer = other.base;
    expect(await attemptUrl(presetFor(fake))).toEqual({
      outcome: 'request_failed',
      consent: undefined,
    });
    expect(fake.authorizeScopes).toEqual([]);
  });

  test('a refresh reply without scope keeps the prior scopes', async () => {
    await connect();
    const before = (await vault.readMcp('server-1'))?.tokens.access_token;
    fake.switches.omitRefreshScope = true;
    const existing = reuse(presetFor(fake));
    expect(
      await auth(existing.provider, {
        serverUrl: fake.url,
        scope: 'read search',
        fetchFn: existing.fetch,
      })
    ).toBe('AUTHORIZED');
    const after = await vault.readMcp('server-1');
    expect(after?.tokens.access_token).not.toBe(before);
    expect(after?.scopes).toEqual(['read', 'search']);
  });

  test('oversized metadata or token bodies fail with response_too_large', async () => {
    fake.switches.oversized = 'metadata';
    expect((await attemptUrl(presetFor(fake))).outcome).toBe('response_too_large');
    fake.switches.oversized = 'token';
    await expect(connect()).rejects.toThrow('response_too_large');
    expect(await vault.readMcp('server-1')).toBeNull();
  });
});
