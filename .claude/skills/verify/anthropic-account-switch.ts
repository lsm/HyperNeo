import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { mock } from 'bun:test';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type {
  ListProviderAuthStatusResponse,
  ProviderAuthResponse,
  ProviderCallbackRelayResponse,
  ProviderLogoutResponse,
  ProviderUsageResult,
} from '../../../packages/shared/src/provider/index.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { credentialService } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';
import { ProviderCredentialManager } from '../../../packages/daemon/src/lib/credentials/provider-credential-manager.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { AnthropicProvider } from '../../../packages/daemon/src/lib/providers/anthropic-provider.ts';
import { CLAUDE_SUBSCRIPTION_OAUTH_CONFIG } from '../../../packages/daemon/src/lib/providers/anthropic-subscription-oauth.ts';
import { getProviderRegistry } from '../../../packages/daemon/src/lib/providers/registry.ts';
import { getSDKSessionFilePath } from '../../../packages/daemon/src/lib/sdk-session-file-manager.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
  assert.equal(process.env[key], undefined);
}

const sdk = await import(
  '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
);
const started: { account: string; resume?: string; sessionId: string }[] = [];
let systemAccountReads = 0;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...sdk,
  query: ({ prompt, options }: {
    prompt: string | AsyncIterable<object>;
    options: { cwd: string; resume?: string; env: Record<string, string | undefined> };
  }) => {
    const token = options.env.CLAUDE_CODE_OAUTH_TOKEN;
    const account =
      token === 'fixture-inherited-login' ? 'system' :
      token === 'fixture-access-replacement' || token === 'fixture-access-rotated' ? 'replacement' : 'unknown';
    const held = Promise.withResolvers<void>();
    return {
      async *[Symbol.asyncIterator]() {
        if (typeof prompt === 'string') return;
        const sessionId = options.resume ?? crypto.randomUUID();
        started.push({ account, resume: options.resume, sessionId });
        const feed = prompt[Symbol.asyncIterator]();
        let next = feed.next();
        const file = getSDKSessionFilePath(options.cwd, sessionId);
        mkdirSync(resolve(file, '..'), { recursive: true });
        while (true) {
          const input = await Promise.race([next, held.promise]);
          if (!input || input.done) return;
          next = feed.next();
          appendFileSync(file, JSON.stringify({ ...input.value, parentUuid: null }) + '\n');
          yield {
          type: 'system', subtype: 'init', session_id: sessionId, uuid: crypto.randomUUID(),
          cwd: options.cwd, model: 'haiku', tools: [], mcp_servers: [], slash_commands: [],
        };
        yield {
          type: 'result', subtype: 'success', session_id: sessionId, uuid: crypto.randomUUID(),
          result: `Answered using ${account}`, is_error: false, num_turns: 1,
          duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, permission_denials: [],
          usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {},
          };
        }
      },
      supportedModels: async () => [],
      supportedCommands: async () => [],
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
      interrupt: async () => held.resolve(),
      close: () => held.resolve(),
      accountInfo: async () => {
        if (account === 'system' && ++systemAccountReads === 1) {
          throw new Error('Synthetic account lookup unavailable');
        }
        return { email: `${account}@example.test` };
      },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          seven_day: {
            utilization: account === 'system' ? 98 : account === 'replacement' ? 24 : -1,
            resets_at: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
      }),
    };
  },
}));
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');

function tokenResponse(account: string, access = account) {
  return Response.json({
    access_token: `fixture-access-${access}`,
    refresh_token: `fixture-refresh-${account}`,
    expires_in: 3600,
    account: { uuid: account, email_address: `${account}@example.test` },
  });
}

const refreshStarted = Promise.withResolvers<void>();
const refreshResponse = Promise.withResolvers<Response>();
let requests = 0;
const fetchToken: typeof fetch = async (url, init) => {
  assert.equal(String(url), CLAUDE_SUBSCRIPTION_OAUTH_CONFIG.tokenUrl);
  requests++;
  const { grant_type: grantType } = JSON.parse(String(init?.body));
  if (grantType === 'refresh_token') {
    if (process.argv.includes('--restart-owned')) return new Response(null, { status: 503 });
    if (requests === 3) return tokenResponse('replacement', 'rotated');
    refreshStarted.resolve();
    return refreshResponse.promise;
  }
  assert.equal(grantType, 'authorization_code');
  return tokenResponse('replacement');
};

const restartMode = process.argv.find((arg) => arg.startsWith('--restart-'));
const provider = new AnthropicProvider(
  { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-inherited-login' },
  'account-switch-verify',
  fetchToken
);
const registry = getProviderRegistry();
if (restartMode) registry.register(provider);
const config = getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') });
const app = await createDaemonApp({
  config: { ...config, disableWorktrees: true, disableGoalProcessing: true },
  standalone: true,
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: createLocalSocket,
});
hub.registerTransport(transport);
const payload = { providerId: 'anthropic' };
const readAuth = async () =>
  (await hub.request<ListProviderAuthStatusResponse>('auth.providers', {})).providers.find(
    ({ id }) => id === 'anthropic'
  );
const readUsage = () => hub.request<ProviderUsageResult>('operation.invoke', {
  name: 'settings.provider.usage',
  input: payload,
});
async function beginLogin() {
  const login = await hub.request<ProviderAuthResponse>('auth.login', payload);
  assert(login.success && login.authUrl);
  const state = new URL(login.authUrl).searchParams.get('state');
  assert(state);
  return () => hub.request<ProviderCallbackRelayResponse>('auth.submitCallback', {
    ...payload,
    callbackInput: `replacement-code#${state}`,
  });
}

async function checkLogoutDuringLogin() {
  const storing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const save = ProviderCredentialManager.prototype.storeOAuthTokens;
  ProviderCredentialManager.prototype.storeOAuthTokens = async function (...args) {
    storing.resolve();
    await release.promise;
    return save.apply(this, args);
  };
  try {
    const submit = await beginLogin();
    const callback = submit();
    await storing.promise;
    const logout = hub.request<ProviderLogoutResponse>('auth.logout', payload);
    await readAuth();
    release.resolve();
    assert((await callback).success, 'A commit already in progress must complete before logout');
    assert((await logout).success);
    assert.equal((await readAuth())?.isAuthenticated, false);
  } finally {
    release.resolve();
    ProviderCredentialManager.prototype.storeOAuthTokens = save;
  }
  console.log('PASS logoutAfterLoginCommit=true');
}
async function sendAndRead(sessionId: string, account: string, count = 1) {
  await hub.request('message.send', { sessionId, content: `Check ${account} login.` });
  const deadline = Date.now() + 20_000;
  let messageTypes: string[] = [];
  while (Date.now() < deadline) {
    const { sdkMessages } = await hub.request<{ sdkMessages: { type: string; result?: string }[] }>(
      'message.sdkMessages', { sessionId }
    );
    messageTypes = sdkMessages.map(({ type }) => type);
    if (sdkMessages.filter((message) => message.type === 'result' && message.result === `Answered using ${account}`).length >= count) return;
    await Bun.sleep(50);
  }
  assert.fail(`The session did not answer using ${account}; launches=${started.map((entry) => entry.account)} messages=${messageTypes}`);
}

async function checkRestart() {
  await transport.initialize();
  const status = await readAuth();
  assert.equal(status?.credentialSource, 'hyperneo');
  if (restartMode !== '--restart-signed-out') {
    assert.equal(status?.isAuthenticated, true);
    assert.equal(status.user?.email, 'replacement@example.test');
    assert(
      provider.buildSdkConfig().envVars.CLAUDE_CODE_OAUTH_TOKEN === 'fixture-access-rotated',
      'SDK launches must use the saved Settings login after restart'
    );
    if (restartMode === '--restart-owned') {
      const retry = await hub.request<{ success: boolean }>('auth.refresh', payload);
      assert.equal(retry.success, false);
      assert.equal(requests, 1);
      console.log('PASS refreshFailed=true');
      return;
    }
    await checkLogoutDuringLogin();
    const manager = ProviderCredentialManager.create(app.db.getDatabase(), {});
    await manager.getCredentialStore().set(
      credentialService('anthropic'), 'default',
      JSON.stringify({ type: 'oauth', accessToken: 'fixture-stale-legacy-login' })
    );
    console.log('PASS restartedWithSettingsLoginAfterFailedRefresh=true');
  } else {
    assert.equal(status?.isAuthenticated, false);
    assert.equal(status.user?.email, undefined);
    assert.throws(() => provider.buildSdkConfig(), /Sign in to Anthropic in HyperNeo Settings/);
    assert.equal((await readUsage()).supported, false);
    console.log('PASS restartedSignedOut=true sdkBlocked=true usageUnavailable=true');
  }
}

async function checkSettings() {
  const dist = resolve('packages/web/dist');
  const front = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, server) {
      const refused = await app.guardRequest(request);
      if (refused) return refused;
      const { pathname } = new URL(request.url);
      if (pathname === '/pair' && request.method === 'POST') return app.handlePair(request);
      if (pathname === '/ws') {
        const device = await app.authenticateUpgrade(request, '127.0.0.1');
        if (!device) return new Response('Pairing required', { status: 401 });
        if (server.upgrade(request, { data: { connectionSessionId: 'global', device } })) return;
        return new Response('Upgrade failed', { status: 500 });
      }
      const file = Bun.file(join(dist, pathname === '/settings' ? 'index.html' : pathname));
      return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
    },
    websocket: createWebSocketHandlers(app.transport, app.sessionManager),
  });
  try {
    const pairing = await hub.request<{ ok: boolean; code: string }>('operation.invoke', {
      name: 'device.pair.create',
      input: { kind: 'human', name: 'Synthetic Settings browser' },
    });
    assert(pairing.ok);
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.VERIFY_BROWSER || undefined,
    });
    try {
      const context = await browser.newContext({ locale: 'en-US' });
      const base = `http://127.0.0.1:${front.port}`;
      const response = await context.request.post(`${base}/pair`, {
        headers: { origin: base },
        data: { code: pairing.code, name: 'Synthetic Settings browser' },
      });
      assert.equal(response.status(), 200);
      const page = await context.newPage();
      await page.goto(`${base}/settings?tab=providers`);
      const email = page.getByText('Signed in as replacement@example.test', { exact: true });
      await email.waitFor({ state: 'visible' });
      assert.equal(await email.count(), 1);
      assert.equal(await page.getByText('Credential source: HyperNeo', { exact: true }).count(), 1);
      assert.equal(await page.getByText('original@example.test', { exact: false }).count(), 0);
      mkdirSync(join(run, 'evidence'), { recursive: true });
      await page.screenshot({ path: join(run, 'evidence/settings.png'), animations: 'disabled' });
      console.log('PASS settingsAccountRows=1 previousAccountRows=0');
    } finally {
      await browser.close();
    }
  } finally {
    front.stop(true);
  }
}

async function checkSwitch() {
  assert.notEqual(app.server.port, 8399);
  const original = {
    type: 'oauth' as const,
    accessToken: 'fixture-access-original',
    refreshToken: 'fixture-refresh-original',
    raw: { account: { uuid: 'original', email_address: 'original@example.test' } },
  };
  registry.unregister('anthropic');
  registry.register(provider);
  const manager = ProviderCredentialManager.create(app.db.getDatabase(), {});
  await transport.initialize();
  const save = ProviderCredentialManager.prototype.storeOAuthTokens;
  ProviderCredentialManager.prototype.storeOAuthTokens = async () => {
    throw new Error('Synthetic credential write failure');
  };
  try {
    const submit = await beginLogin();
    assert.equal((await submit()).success, false);
    const { providers } = await hub.request<{ providers: { providerId: string; authType: string }[] }>(
      'providers.list', {}
    );
    assert.equal(providers.find((row) => row.providerId === 'anthropic')?.authType, 'none');
    assert.equal(await manager.hasAnthropicSettingsLogin(), false);
  } finally {
    ProviderCredentialManager.prototype.storeOAuthTokens = save;
  }
  assert.equal(requests, 1);
  requests = 0;

  const account = async () => (await readAuth())?.user?.email;

  const inherited = await readAuth();
  assert(inherited?.isAuthenticated, 'The system login must be available before Settings login');
  assert.equal(inherited.credentialSource, 'inherited');
  assert.equal(inherited.method, 'oauth', 'The system subscription must be reported as OAuth');
  assert.equal(inherited.user?.email, undefined);
  assert.equal((await readAuth())?.user?.email, 'system@example.test');
  const inheritedUsage = await readUsage();
  assert(inheritedUsage.supported);
  assert.equal(inheritedUsage.windows[0]?.used, 98);
  const workspace = join(run, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: workspace,
    title: 'Synthetic Anthropic login',
    config: { provider: 'anthropic', model: 'haiku' },
  });
  await sendAndRead(sessionId, 'system');
  provider.setCredentials(original);
  await manager.storeOAuthTokens('anthropic', original);

  const refreshing = hub.request('auth.refresh', payload);
  await refreshStarted.promise;
  assert((await hub.request<ProviderLogoutResponse>('auth.logout', payload)).success);
  assert.equal(await account(), undefined);
  assert.equal((await readAuth())?.isAuthenticated, false);
  const submit = await beginLogin();
  assert((await submit()).success);
  assert.equal(await account(), 'replacement@example.test');
  assert.equal((await readAuth())?.credentialSource, 'hyperneo');
  const ownedUsage = await readUsage();
  assert(ownedUsage.supported);
  assert.equal(ownedUsage.windows[0]?.used, 24);
  refreshResponse.resolve(tokenResponse('original'));
  await refreshing;
  await sendAndRead(sessionId, 'replacement');
  assert.equal(started.length, 2);
  assert.equal(started[1]?.resume, started[0]?.sessionId);
  assert(
    provider.buildSdkConfig().envVars.CLAUDE_CODE_OAUTH_TOKEN === 'fixture-access-replacement',
    'SDK launches must use the replacement login'
  );
  assert(
    (await account()) === 'replacement@example.test',
    'The late refresh changed the signed-in account'
  );
  const persisted = await manager.getCredentials('anthropic');
  const persistedAccount = persisted?.raw?.account as { uuid?: string } | undefined;
  assert.equal(persistedAccount?.uuid, 'replacement');
  const rotated = await hub.request<{ success: boolean }>('auth.refresh', payload);
  assert(rotated.success);
  assert(provider.buildSdkConfig().envVars.CLAUDE_CODE_OAUTH_TOKEN === 'fixture-access-rotated');
  await sendAndRead(sessionId, 'replacement', 2);
  assert.equal(started.length, 2, 'A token rotation must keep the live SDK process');
  assert.equal(requests, 3);
  console.log('PASS requests=3 replacementAccountRetained=true persistedAccountMatches=true usageSwitched=true sdkRetainedOnRefresh=true');
  if (process.argv.includes('--web')) await checkSettings();
}

try {
  if (restartMode) await app.jobProcessor.stop();
  if (restartMode) await checkRestart();
  else await checkSwitch();
} finally {
  refreshResponse.resolve(new Response(null, { status: 503 }));
  await transport.close();
  await app.cleanup();
}
if (!restartMode) {
  for (const mode of ['--restart-owned', '--restart-after-failed-refresh', '--restart-signed-out']) {
    const child = Bun.spawn([process.execPath, import.meta.path, mode, run], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    assert.equal(await child.exited, 0, 'The restarted daemon proof must pass');
  }
}
