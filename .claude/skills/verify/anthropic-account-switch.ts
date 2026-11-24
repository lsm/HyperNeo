import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type {
  ListProviderAuthStatusResponse,
  ProviderAuthResponse,
  ProviderCallbackRelayResponse,
  ProviderLogoutResponse,
} from '../../../packages/shared/src/provider/index.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { ProviderCredentialManager } from '../../../packages/daemon/src/lib/credentials/provider-credential-manager.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { AnthropicProvider } from '../../../packages/daemon/src/lib/providers/anthropic-provider.ts';
import { CLAUDE_SUBSCRIPTION_OAUTH_CONFIG } from '../../../packages/daemon/src/lib/providers/anthropic-subscription-oauth.ts';
import { getProviderRegistry } from '../../../packages/daemon/src/lib/providers/registry.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
  assert.equal(process.env[key], undefined);
}

function tokenResponse(account: string) {
  return Response.json({
    access_token: `fixture-access-${account}`,
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
    refreshStarted.resolve();
    return refreshResponse.promise;
  }
  assert.equal(grantType, 'authorization_code');
  return tokenResponse('replacement');
};

const config = getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') });
const app = await createDaemonApp({ config, standalone: true, verbose: false });
const registry = getProviderRegistry();
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: createLocalSocket,
});
hub.registerTransport(transport);

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

try {
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const provider = new AnthropicProvider({}, 'account-switch-verify', fetchToken);
  const original = {
    type: 'oauth' as const,
    accessToken: 'fixture-access-original',
    refreshToken: 'fixture-refresh-original',
    raw: { account: { uuid: 'original', email_address: 'original@example.test' } },
  };
  provider.setCredentials(original);
  registry.unregister('anthropic');
  registry.register(provider);
  app.db.providers.createProvider({
    providerId: 'anthropic',
    displayName: 'Anthropic',
    kind: 'built_in',
    authType: 'oauth',
    isEnabled: true,
  });
  const manager = ProviderCredentialManager.create(app.db.getDatabase(), {});
  await manager.storeOAuthTokens('anthropic', original);
  await transport.initialize();

  const payload = { providerId: 'anthropic' };
  const account = async () =>
    (await hub.request<ListProviderAuthStatusResponse>('auth.providers', {})).providers.find(
      ({ id }) => id === 'anthropic'
    )?.user?.email;

  const refreshing = hub.request('auth.refresh', payload);
  await refreshStarted.promise;
  assert((await hub.request<ProviderLogoutResponse>('auth.logout', payload)).success);
  assert.equal(await account(), undefined);
  const login = await hub.request<ProviderAuthResponse>('auth.login', payload);
  assert(login.success && login.authUrl);
  const state = new URL(login.authUrl).searchParams.get('state');
  assert(state);
  assert(
    (await hub.request<ProviderCallbackRelayResponse>('auth.submitCallback', {
      ...payload,
      callbackInput: `replacement-code#${state}`,
    })).success
  );
  assert.equal(await account(), 'replacement@example.test');
  refreshResponse.resolve(tokenResponse('original'));
  await refreshing;
  assert(
    (await account()) === 'replacement@example.test',
    'The late refresh changed the signed-in account'
  );
  const persisted = await manager.getCredentials('anthropic');
  const persistedAccount = persisted?.raw?.account as { uuid?: string } | undefined;
  assert.equal(persistedAccount?.uuid, 'replacement');
  assert.equal(requests, 2);
  console.log('PASS requests=2 replacementAccountRetained=true persistedAccountMatches=true');
  if (process.argv.includes('--web')) await checkSettings();
} finally {
  refreshResponse.resolve(new Response(null, { status: 503 }));
  await transport.close();
  await app.cleanup();
}
