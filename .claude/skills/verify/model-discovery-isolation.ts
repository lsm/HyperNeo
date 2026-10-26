import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { getProviderRegistry } from '../../../packages/daemon/src/lib/providers/registry.ts';
import { clearModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
import { createHttpWsServer } from '../../../packages/daemon/src/lib/runtime-server/index.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import type { Provider } from '../../../packages/shared/src/provider/index.ts';

const run = resolve(process.argv.at(-1)!);
const [node, browserModules, chromium] = process.argv.slice(2, -1);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: Record<string, unknown> = { steps: [] };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
let webServer: Awaited<ReturnType<typeof createHttpWsServer>> | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true, disableGoalProcessing: true, verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const starts: Record<string, number> = {};
  const model = { id: 'cold-model', name: 'Cold model', provider: 'cold-fixture', contextWindow: 128000, available: true };
  for (const [id, discover] of [
    ['cold-fixture', async () => { starts['cold-fixture'] = performance.now(); await Bun.sleep(15000); return [model]; }],
    ['dead-fixture', () => { starts['dead-fixture'] = performance.now(); return new Promise<never>(() => {}); }],
  ] as const) {
    getProviderRegistry().register({ id, displayName: id, isAvailable: () => true, getModels: discover, listRemoteModels: discover, ownsModel: () => false, getModelForTier: () => undefined, buildSdkConfig: () => ({ envVars: {} }) } as unknown as Provider);
  }
  clearModelsCache();
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('WS failed')); });
  const id = crypto.randomUUID();
  const startedAt = performance.now();
  const result = await new Promise<Record<string, unknown>>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('models.list exceeded 40 seconds')), 40000);
    ws!.onmessage = event => {
      const reply = JSON.parse(String(event.data));
      if ((reply.requestId ?? reply.id) !== id) return;
      clearTimeout(timer); done(reply);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'models.list', data: { forceRefresh: true }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  evidence.elapsedMs = performance.now() - startedAt;
  evidence.starts = starts; evidence.reply = result;
  assert(!result.error, JSON.stringify(result.error));
  const data = result.data as { models: { id: string; available: boolean }[]; unavailableProviders: { providerId: string; available: boolean }[] };
  assert(data.models.some(model => model.id === 'cold-model' && model.available));
  assert(data.unavailableProviders.some(provider => provider.providerId === 'dead-fixture' && !provider.available));
  assert(Math.abs(starts['cold-fixture'] - starts['dead-fixture']) < 100);
  assert(Number(evidence.elapsedMs) < 35000);
  if (node) {
    clearModelsCache();
    const daemon = app;
    webServer = await createHttpWsServer({
      hostname: '127.0.0.1', port: 0,
      async fetch(req, upgrade, client) {
        const url = new URL(req.url);
        const refused = daemon.guardRequest(req);
        if (refused) return refused;
        if (url.pathname === '/ws') return upgrade(req, {
          connectionSessionId: 'global', device: await daemon.authenticateUpgrade(req, client?.remoteAddress ?? null),
        }) ?? new Response('Upgrade failed', { status: 500 });
        const path = url.pathname.startsWith('/assets/') ? url.pathname : '/index.html';
        const file = Bun.file(join(process.cwd(), 'packages/web/dist', path));
        return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
      },
      websocket: createWebSocketHandlers(daemon.transport, daemon.sessionManager),
    });
    assert.notEqual(webServer.port, 8399);
    const browser = Bun.spawn([node, '.claude/skills/verify/model-discovery-web.mjs', String(webServer.port), run], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', NODE_PATH: browserModules, VERIFY_BROWSER: chromium },
      stdout: 'inherit', stderr: 'inherit',
    });
    assert.equal(await browser.exited, 0, 'Settings browser proof failed');
    evidence.browser = 'model-discovery-browser.json and PNG';
  }
  evidence.passed = true;
} catch (error) { evidence.error = String(error); throw error; }
finally {
  webServer?.stop(true); ws?.close(); clearModelsCache(); await app?.cleanup();
  writeFileSync(join(run, 'evidence/model-discovery.json'), JSON.stringify(evidence, null, 2));
}
