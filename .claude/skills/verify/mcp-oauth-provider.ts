import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { auth } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createCredentialStore } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';
import { ConnectionVault } from '../../../packages/daemon/src/lib/connections/vault.ts';
import { createMcpOAuthProvider } from '../../../packages/daemon/src/lib/connections/mcp-oauth-provider.ts';
import type { McpOAuthPreset } from '../../../packages/daemon/src/lib/connections/mcp-fetch.ts';
import { startFakeMcpOAuthServer } from '../../../packages/daemon/tests/helpers/fake-mcp-oauth-server.ts';

const run = resolve(process.argv.at(-1) ?? '');
const testedHead = process.argv.length > 3 ? process.argv[2] : 'unrecorded';
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
mkdirSync(join(run, 'evidence'), { recursive: true });

const fake = await startFakeMcpOAuthServer({ advertiseAllScopes: true });
const other = await startFakeMcpOAuthServer();
const preset: McpOAuthPreset = { url: fake.url, issuer: fake.base, authorizationEndpoint: `${fake.base}/authorize`, origins: [fake.base], scopes: ['read', 'search'] };
const config = () => getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
const evidence: Record<string, unknown> = {};
const secrets: string[] = [];
let app = await createDaemonApp({ config: config(), verbose: false });
try {
  await app.jobProcessor.stop();
  const vault = () => new ConnectionVault(createCredentialStore(app.db.getDatabase()), 'proof-instance');
  let consent: URL | undefined;
  const attempt = createMcpOAuthProvider({ vault: vault(), serverId: 'row-1', preset, generation: 1, redirectUrl: 'http://127.0.0.1:9/callback', attempt: { authorize: (url) => { consent = url; } } });
  const options = { serverUrl: fake.url, scope: 'read search', fetchFn: attempt.fetch };
  assert.equal(await auth(attempt.provider, options), 'REDIRECT');
  assert(consent);
  const code = new URL((await fetch(consent, { redirect: 'manual' })).headers.get('location') ?? '').searchParams.get('code') ?? '';
  assert.equal(await auth(attempt.provider, { ...options, authorizationCode: code }), 'AUTHORIZED');
  await attempt.commit();
  evidence.authorizeScopes = fake.authorizeScopes;
  evidence.registered = fake.requests.some((request) => request.path === '/register');
  evidence.pkceVerified = fake.requests.some((request) => request.path === '/token' && request.params.has('code_verifier'));

  await app.cleanup();
  app = await createDaemonApp({ config: config(), verbose: false });
  await app.jobProcessor.stop();
  const grant = await vault().readMcp('row-1');
  assert(grant);
  secrets.push(grant.tokens.access_token, String(grant.tokens.refresh_token));
  const db = app.db.getDatabase();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(({ name }) => name);
  const rows = JSON.stringify(tables.map((name) => db.prepare(`SELECT * FROM "${name}"`).all()));
  evidence.afterRestart = { grantScopes: grant.scopes, generation: grant.generation, tablesScanned: tables.length, tokenInAnyRow: secrets.some((secret) => rows.includes(secret)) };
  assert.deepEqual(grant.scopes, ['read', 'search']);
  assert.equal((evidence.afterRestart as { tokenInAnyRow: boolean }).tokenInAnyRow, false);
  evidence.otherInstanceReads = await new ConnectionVault(createCredentialStore(db), 'other-instance').readMcp('row-1');
  evidence.otherRowReads = await vault().readMcp('row-2');
  assert.equal(evidence.otherInstanceReads, null);
  assert.equal(evidence.otherRowReads, null);

  const existing = createMcpOAuthProvider({ vault: vault(), serverId: 'row-1', preset, generation: 1, redirectUrl: 'http://127.0.0.1:9/callback' });
  const refreshed = await auth(existing.provider, { serverUrl: fake.url, scope: 'read search', resourceMetadataUrl: new URL(`${other.base}/.well-known/oauth-protected-resource/mcp`), fetchFn: existing.fetch });
  evidence.foreign401 = { refreshed, requestsToOtherServer: other.requests.length };
  assert.equal(other.requests.length, 0);
} finally {
  fake.stop();
  other.stop();
  await app.cleanup();
}
const text = JSON.stringify({ testedHead, surface: 'real SDK auth() in an isolated test-daemon process against a loopback fake MCP OAuth server; vault on the daemon database; no connect RPC yet', evidence, resourcesClosed: true }, null, 2);
assert(!secrets.some((secret) => text.includes(secret)));
writeFileSync(join(run, 'evidence/mcp-oauth-provider.json'), text);
console.log('PASS: discovery, DCR and PKCE through the real SDK; grant only in the vault and readable after restart; other instance and row read nothing; foreign 401 reached no other server');
