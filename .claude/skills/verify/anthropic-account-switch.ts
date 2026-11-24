import assert from 'node:assert/strict';
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
} finally {
  refreshResponse.resolve(new Response(null, { status: 503 }));
  await transport.close();
  await app.cleanup();
}
