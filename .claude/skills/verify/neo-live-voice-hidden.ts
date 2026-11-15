process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const [directory] = process.argv.slice(2);
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
for (const part of ['workspace', 'evidence']) mkdirSync(join(run, part), { recursive: true });
const network = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'external network disabled');
  return network(input, init);
}) as typeof fetch;

const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
const sessionId = 'neo:10000000-0000-4000-8000-000000010600';
const evidence: Record<string, unknown> = { passed: false, schemes: {} };
let front: ReturnType<typeof Bun.serve> | undefined;
let browser: { newContext(options?: unknown): Promise<any>; close(): Promise<void> } | undefined;
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await app.settingsManager.updateGlobalSettings({
    language: 'en',
    voice: {
      enabled: true,
      endpoint: 'http://127.0.0.1:1/v1/audio/transcriptions',
      model: 'stub',
      allowPrivateNetwork: true,
    },
  });
  const now = new Date().toISOString();
  await app.db.createSession({
    id: sessionId,
    title: 'Synthetic composer Neo',
    workspacePath: join(run, 'workspace'),
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
  });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId, kind: 'neo', projectId: null });
  const wait = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 1500 && !(await check()); i++) await new Promise((done) => setTimeout(done, 20));
    assert(await check());
  };

  const dist = resolve('packages/web/dist');
  assert(existsSync(join(dist, 'neo/index.html')), 'build packages/web first');
  front = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, server) {
      const refusal = await app.guardRequest(request);
      if (refusal) return refusal;
      const path = new URL(request.url).pathname;
      if (path === '/ws') {
        const device = await app.authenticateUpgrade(request, '127.0.0.1');
        if (!device) return new Response('Unauthorized', { status: 401 });
        if (server.upgrade(request, { data: { connectionSessionId: 'global', device } })) return;
        return new Response('Upgrade failed', { status: 500 });
      }
      const file = Bun.file(join(dist, path === '/neo' ? 'neo/index.html' : path));
      return (await file.exists()) ? new Response(file) : new Response('Not found', { status: 404 });
    },
    websocket: createWebSocketHandlers(app.transport, app.sessionManager),
  });
  assert(![8399, 8499].includes(front.port));

  const { chromium } = createRequire(join(process.env.NODE_PATH || run, 'noop.js'))('playwright');
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.VERIFY_BROWSER || undefined,
  });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  const transport = new WebSocketClientTransport({
    createSocket: createLocalSocket,
    url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false,
  });
  hub.registerTransport(transport);
  await transport.initialize();
  const paired = await hub.request<{ ok: boolean; code: string }>('operation.invoke', {
    name: 'device.pair.create',
    input: { kind: 'human', name: 'Synthetic composer browser' },
  });
  await transport.close();
  hub.cleanup();
  assert(paired.ok);
  const pairBase = `http://127.0.0.1:${app.server.port}`;
  const pairing = await browser.newContext();
  const redeemed = await pairing.request.post(`${pairBase}/pair`, {
    headers: { origin: pairBase },
    data: { code: paired.code, name: 'Synthetic composer browser' },
  });
  assert.equal(redeemed.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();

  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      storageState,
      colorScheme,
      viewport: { width: 1280, height: 860 },
    });
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${front.port}/neo`);
      const mic = page.locator('button[aria-label="Start voice input"]');
      try {
        await mic.waitFor({ state: 'visible', timeout: 30_000 });
      } catch (error) {
        await page.screenshot({ path: join(run, `evidence/failure-${colorScheme}.png`) });
        throw error;
      }
      await wait(async () => (await page.locator('form.neo-composer-input').count()) > 0);
      assert.equal(await page.locator('button[aria-label="Realtime voice"]').count(), 0);
      assert.equal(await page.locator('button[aria-label="Stop realtime voice"]').count(), 0);
      await page.locator('form.neo-composer-input').screenshot({
        path: join(run, `evidence/composer-${colorScheme}.png`),
      });
      (evidence.schemes as Record<string, unknown>)[colorScheme] = {
        micVisible: true,
        micEnabled: !(await mic.isDisabled()),
        realtimeButtons: 0,
      };
    } finally {
      await context.close();
    }
  }
  evidence.passed = true;
  console.log(JSON.stringify(evidence));
} finally {
  writeFileSync(join(run, 'evidence/neo-live-voice-hidden.json'), JSON.stringify(evidence, null, 2));
  await browser?.close();
  front?.stop(true);
  await app.cleanup();
  globalThis.fetch = network;
}
