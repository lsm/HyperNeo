import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { setModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
import { answerCodexProbeLocally, oxapCodexProvider } from './oxap-codex-provider.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
const run = process.env.HYPERNEO_DATA_DIR!.replace(/\/data$/, '');
answerCodexProbeLocally();
const app = await createDaemonApp({
  config: {
    ...getConfig({
      host: '127.0.0.1',
      port: 31397,
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
  port: 31397,
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
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: createLocalSocket,
});
rpc.registerTransport(transport);
await transport.initialize();
await rpc.request('providers.create', oxapCodexProvider);
setModelsCache(
  new Map([
    [
      'global',
      [
        {
          id: 'codex-6-luna',
          name: 'Synthetic Codex',
          alias: 'codex-6-luna',
          family: 'gpt',
          provider: 'anthropic-codex',
          contextWindow: 128000,
          description: '',
          releaseDate: '',
          available: true,
        },
      ],
    ],
  ])
);
await rpc.request('models.list', {});
const listProviders = app.db.providers.listProviders.bind(app.db.providers);
let failProviderList = true;
app.db.providers.listProviders = () => {
  if (failProviderList) {
    failProviderList = false;
    throw new Error('Synthetic provider lookup failure');
  }
  return listProviders();
};
console.log('READY');
process.on('SIGTERM', async () => {
  await transport.close();
  server.stop();
  await app.cleanup();
  process.exit(0);
});
