import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
  assert(!process.env[key], `${key} must not be set`);
}
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'data', 'evidence']) mkdirSync(join(run, name), { recursive: true });

const { Database } = await import('../../../packages/daemon/src/storage/index.ts');
const { createReactiveDatabase } = await import('../../../packages/daemon/src/storage/reactive-database.ts');
const { ProviderCredentialManager } = await import('../../../packages/daemon/src/lib/credentials/provider-credential-manager.ts');
const { OAuthRefreshScheduler, refreshDelayMs } = await import('../../../packages/daemon/src/lib/credentials/oauth-refresh-scheduler.ts');
const { AnthropicProvider } = await import('../../../packages/daemon/src/lib/providers/anthropic-provider.ts');
const { ProviderRegistry } = await import('../../../packages/daemon/src/lib/providers/registry.ts');
const { CLAUDE_SUBSCRIPTION_OAUTH_CONFIG } = await import('../../../packages/daemon/src/lib/providers/anthropic-subscription-oauth.ts');
const { subscribeToStructuredLogs } = await import('../../../packages/daemon/src/lib/logger.ts');

const ACCESS = 'synthetic-access-secret';
const REFRESH = 'synthetic-refresh-secret';
const replies: Array<{ status: number; error: string }> = [{ status: 503, error: REFRESH }];
const requests: Array<{ status: number; error: string }> = [];
const tokenServer = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: () => {
    const reply = replies.shift() ?? { status: 503, error: 'temporarily_unavailable' };
    requests.push(reply);
    return Response.json({ error: reply.error }, { status: reply.status });
  },
});
const fetchImpl: typeof fetch = (input, init) => {
  assert.equal(String(input), CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.tokenUrl);
  return fetch(`http://127.0.0.1:${tokenServer.port}/v1/oauth/token`, init);
};

const logs: string[] = [];
const unsubscribe = subscribeToStructuredLogs((event) => {
  if (event.message.includes('OAuth refresh failed')) logs.push(event.message);
});
const db = new Database(join(run, 'data/daemon.db'));
const evidence: Record<string, unknown> = {};
try {
  await db.initialize(createReactiveDatabase(db));
  db.providers.createProvider({
    providerId: 'anthropic',
    displayName: 'Synthetic Claude login',
    kind: 'built_in',
    authType: 'oauth',
  });
  const manager = ProviderCredentialManager.create(db.getDatabase(), {});
  let now = Date.now();
  const credentials = { type: 'oauth' as const, accessToken: ACCESS, refreshToken: REFRESH, expiresAt: now + 60_000 };
  await manager.storeOAuthTokens('anthropic', credentials);
  const provider = new AnthropicProvider({}, 'verify-oauth-background-refresh', fetchImpl);
  provider.setCredentials(credentials);
  const registry = new ProviderRegistry();
  registry.register(provider);
  const scheduler = new OAuthRefreshScheduler(manager, {
    registry,
    now: () => now,
    setNeedsLogin: (providerId, at) => db.providers.setNeedsLogin(providerId, at),
  });

  const transient = 5;
  for (let attempt = 1; attempt <= transient; attempt += 1) {
    await scheduler.tick();
    assert.equal(requests.length, attempt, `transient attempt ${attempt} reached the endpoint`);
    now += refreshDelayMs(attempt) - 1;
    await scheduler.tick();
    assert.equal(requests.length, attempt, 'no refresh before the clock comes round');
    now += 1;
  }
  evidence.transientRequests = requests.length;
  evidence.clockAfterTransient = scheduler.clock('anthropic');
  assert.equal(db.providers.getNeedsLoginAt('anthropic'), null);

  replies.push({ status: 400, error: 'invalid_grant' });
  const refusedAt = now;
  await scheduler.tick();
  assert.equal(requests.length, transient + 1);
  assert.equal(db.providers.getNeedsLoginAt('anthropic'), refusedAt);
  now += 3 * 60 * 60_000;
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(requests.length, transient + 1, 'background refresh stops after definitive');
  evidence.requests = requests;
  evidence.needsLoginAt = db.providers.getNeedsLoginAt('anthropic');
  evidence.health = db.providers.getProviderByProviderId('anthropic')?.healthStatus;
  assert.equal(evidence.health, 'unhealthy');

  assert.equal(logs.length, transient + 1);
  assert.match(logs[0], /outcome=transient oauthError=unrecognized/);
  for (const line of logs.slice(1, transient)) {
    assert.match(line, /outcome=transient oauthError=temporarily_unavailable/);
  }
  assert.match(logs[transient], /outcome=definitive oauthError=invalid_grant/);
  for (const line of logs) assert(!line.includes(ACCESS) && !line.includes(REFRESH));
  evidence.logs = logs;
  writeFileSync(join(run, 'evidence/observed.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`PASS requests=${requests.length} logs=${logs.length} needsLoginAt=${evidence.needsLoginAt}`);
} finally {
  unsubscribe();
  tokenServer.stop(true);
  await db.close();
}
