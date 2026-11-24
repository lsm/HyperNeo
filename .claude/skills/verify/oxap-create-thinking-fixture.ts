import { existsSync } from 'node:fs';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { setModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
import { answerCodexProbeLocally, oxapCodexProvider, seedSyntheticCodexAdmission, serveLocalRelease } from './oxap-codex-provider.ts';
import { releaseName } from '../../../packages/daemon/src/lib/oxap/oxap-install.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
const harnessChoice = process.argv[2] === 'harness';
const claudePicker = process.argv[2] === 'claude-picker';
const port = claudePicker ? 0 : 31397;
const run = process.env.HYPERNEO_DATA_DIR!.replace(/\/data$/, '');
answerCodexProbeLocally();
serveLocalRelease('/usr/bin/true', releaseName(), `${run}/release`);
const releaseFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
  const url = args[0] instanceof Request ? args[0].url : String(args[0]);
  if (!harnessChoice && url.endsWith('/SHA256SUMS.txt')) await new Promise((resolve) => setTimeout(resolve, 11_000));
  return releaseFetch(...args);
}, { preconnect: releaseFetch.preconnect }) as typeof fetch;
const app = await createDaemonApp({
  config: {
    ...getConfig({
      host: '127.0.0.1',
      port,
      dbPath: `${run}/data/daemon.db`,
      workspaceRoot: run,
    }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
await app.jobProcessor.stop();
app.server.stop();
const { createWebSocketHandlers } = await import(
  '../../../packages/daemon/src/routes/setup-websocket.ts'
);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(req, server) {
    const refused = await app.guardRequest(req);
    if (refused) return refused;
    const url = new URL(req.url);
    if (url.pathname === '/pair' && req.method === 'POST') return app.handlePair(req);
    if (url.pathname === '/ws') {
      const device = await app.authenticateUpgrade(req, server.requestIP(req)?.address ?? null);
      if (!device) return new Response('unauthorized', { status: 401 });
      if (server.upgrade(req, { data: { connectionSessionId: 'global', device } })) return;
      return new Response('upgrade failed', { status: 500 });
    }
    const path = url.pathname.startsWith('/assets/') ? url.pathname : '/index.html';
    const file = Bun.file(`${process.cwd()}/packages/web/dist${path}`);
    return new Response(file);
  },
  websocket: createWebSocketHandlers(app.transport, app.sessionManager),
});
const rpc = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${server.port}/ws`,
  autoReconnect: false,
  createSocket: createLocalSocket,
});
rpc.registerTransport(transport);
await transport.initialize();
if (claudePicker) {
  app.settingsManager.updateGlobalSettings({
    model: 'codex-6-luna',
    modelProvider: 'anthropic-codex',
    oxapHub: { path: process.execPath, version: 'synthetic-fixture', sha256: '0'.repeat(64) },
  });
  await rpc.request('providers.create', {
    params: {
      ...oxapCodexProvider.params,
      authType: 'oauth',
      configJson: JSON.stringify({ harness: 'oxap-codex', harnessSettings: { executable: process.execPath } }),
    },
    credentials: { oauthAccessToken: 'synthetic-picker-token' },
  });
} else {
  await seedSyntheticCodexAdmission(rpc, app.settingsManager);
  await rpc.request('providers.create', {
    params: { providerId: 'anthropic', displayName: 'Synthetic SDK', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: false, sortOrder: 2 },
    credentials: { apiKey: 'sk-devproxy-test-key' },
  });
}
if (harnessChoice) {
  app.settingsManager.updateGlobalSettings({
    model: 'sonnet',
    modelProvider: 'anthropic-codex',
    fallbackModels: [{ provider: 'anthropic-codex', model: 'codex-6-luna' }],
  });
  await rpc.request('providers.create', {
    params: {
      providerId: 'deepseek', displayName: 'Synthetic DeepSeek', kind: 'built_in',
      authType: 'api_key', isEnabled: true, isDefault: false, sortOrder: 3,
      configJson: JSON.stringify({ harnessSettings: { executable: process.execPath } }),
    },
  });
}
setModelsCache(
  new Map([
    [
      'global',
      [
        {
          id: 'codex-6-luna',
          name: 'Synthetic Codex',
          codexReasoning: { levels: ['low', 'high', 'ultra'], defaultLevel: 'low' },
          alias: 'codex-6-luna',
          family: 'gpt',
          provider: 'anthropic-codex',
          contextWindow: 128000,
          description: '',
          releaseDate: '',
          available: true,
        },
        claudePicker ? {
          id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', alias: 'gpt-5.6-luna',
          family: 'gpt', provider: 'anthropic-codex',
          contextWindow: 128000, description: '', releaseDate: '', available: true,
        } : {
          id: 'synthetic-sdk', name: 'Synthetic SDK Model', alias: 'synthetic-sdk', family: 'sonnet',
          provider: 'anthropic', contextWindow: 128000, description: '', releaseDate: '', available: true,
        },
        ...(harnessChoice ? [{
          id: 'deepseek-v4-pro', name: 'Synthetic DeepSeek', alias: 'deepseek-v4-pro',
          family: 'deepseek' as const, provider: 'deepseek' as const, contextWindow: 128000,
          description: '', releaseDate: '', available: true,
        }] : []),
      ],
    ],
  ])
);
await rpc.request('models.list', {});
if (claudePicker) {
  const session = await rpc.request<{ sessionId: string }>('session.create', {
    title: 'Existing Claude Code chat', workspacePath: `${run}/home`, harness: 'sdk',
    config: { provider: 'anthropic-codex', model: 'codex-6-luna', queryMode: 'manual' },
  });
  console.log(`CLAUDE_PICKER_SESSION=${session.sessionId}`);
} else if (!harnessChoice) {
  const seeded = await rpc.request<{ sessionId: string }>('session.create', {
    title: 'Synthetic sign-in', workspacePath: `${run}/home`,
    config: { provider: 'anthropic-codex', model: 'codex-6-luna', queryMode: 'manual' },
  });
  await app.db.saveSDKMessage(seeded.sessionId, {
    type: 'auth_status', isAuthenticating: true, uuid: crypto.randomUUID(),
    session_id: seeded.sessionId, output: ['Open https://example.com/device.', 'Enter code SYNTHETIC'],
  });
  console.log(`AUTH_SESSION=${seeded.sessionId}`);
  const settings = await rpc.request<{ sessionId: string }>('session.create', {
    title: 'Synthetic thinking settings', workspacePath: `${run}/home`,
    config: { provider: 'anthropic-codex', model: 'codex-6-luna', thinkingLevel: 'think24k', queryMode: 'manual' },
  });
  console.log(`SETTINGS_SESSION=${settings.sessionId}`);
}
const listProviders = app.db.providers.listProviders.bind(app.db.providers);
let failProviderList = !harnessChoice && !claudePicker;
app.db.providers.listProviders = () => {
  const marker = `${run}/fail-provider-list`;
  if (existsSync(marker)) {
    throw new Error('Synthetic provider lookup failure');
  }
  if (failProviderList) {
    failProviderList = false;
    throw new Error('Synthetic provider lookup failure');
  }
  return listProviders();
};
console.log(`READY ${server.port}`);
process.on('SIGTERM', async () => {
  await transport.close();
  server.stop();
  await app.cleanup();
  process.exit(0);
});
