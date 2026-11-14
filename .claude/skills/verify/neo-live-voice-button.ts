process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const [mode, directory] = process.argv.slice(2);
const run = resolve(directory);
assert(['configured', 'unconfigured'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
for (const part of ['workspace', 'evidence']) mkdirSync(join(run, part), { recursive: true });
const network = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'external network disabled');
  return network(input, init);
}) as typeof fetch;

const RATE = 24000;
const tts = createServer(async (request, response) => {
  if (request.url === '/v1/audio/voices')
    return void response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ model: 'fixture', data: [{ id: 'vivian', name_en: 'Vivian' }] }));
  if (request.url !== '/v1/audio/speech') return void response.writeHead(404).end('{}');
  for await (const _ of request) {
  }
  const samples = RATE;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    pcm.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / RATE) * 12000), i * 2);
  response.writeHead(200, { 'Content-Type': 'audio/pcm' });
  response.end(pcm);
});
await new Promise<void>((done) => tts.listen(0, '127.0.0.1', done));
if (mode === 'configured')
  process.env.HYPERNEO_SPEECH_URL = `http://127.0.0.1:${(tts.address() as AddressInfo).port}`;
else delete process.env.HYPERNEO_SPEECH_URL;

const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
const sessionId = 'neo:10000000-0000-4000-8000-000000010600';
const evidence: Record<string, unknown> = { mode, passed: false };
let front: ReturnType<typeof Bun.serve> | undefined;
let browser: { newPage(options?: unknown): Promise<any>; close(): Promise<void> } | undefined;
let page: any;
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await app.settingsManager.updateGlobalSettings({ language: 'en' });
  const now = new Date().toISOString();
  await app.db.createSession({
    id: sessionId,
    title: 'Synthetic live voice Neo',
    workspacePath: join(run, 'workspace'),
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
  });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId, kind: 'neo', projectId: null });
  const mcp = createOperationMcpHandler(
    () => app.sessionManager.getOperationRegistry(),
    () => ({ sessionId, role: 'neo' })
  );
  const receipts = () =>
    (
      app.db
        .getDatabase()
        .prepare("SELECT reason FROM operation_refusals WHERE operation='neo.speech' ORDER BY rowid")
        .all() as { reason: string }[]
    ).map((row) => JSON.parse(row.reason) as { id: string; state: string });
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
  browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER || undefined });
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
    input: { kind: 'human', name: 'Synthetic live voice browser' },
  });
  await transport.close();
  hub.cleanup();
  assert(paired.ok);
  const pairBase = `http://127.0.0.1:${app.server.port}`;
  const pairing = await (browser as any).newContext();
  const redeemed = await pairing.request.post(`${pairBase}/pair`, {
    headers: { origin: pairBase },
    data: { code: paired.code, name: 'Synthetic live voice browser' },
  });
  assert.equal(redeemed.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  const context = await (browser as any).newContext({ storageState, viewport: { width: 1280, height: 860 } });
  page = await context.newPage();
  await page.goto(`http://127.0.0.1:${front.port}/neo`);
  const button = page.locator('button[aria-label="Realtime voice"]');
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  await wait(async () => !(await button.isDisabled()));
  await page.screenshot({ path: join(run, 'evidence/off.png') });
  await button.click();

  if (mode === 'unconfigured') {
    const notice = page.getByText('Voice replies are not set up on this daemon.');
    await notice.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
    await page.screenshot({ path: join(run, 'evidence/not-configured.png') });
    Object.assign(evidence, { passed: true, noticeShown: true, stayedOff: true, receipts: receipts() });
  } else {
    const stopButton = page.locator('button[aria-label="Stop realtime voice"][aria-pressed="true"]');
    await stopButton.waitFor({ state: 'visible', timeout: 10_000 });
    await page.mouse.move(0, 0);
    await stopButton.evaluate((element: HTMLElement) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished))
    );
    await page.screenshot({ path: join(run, 'evidence/listening.png') });
    const style = await stopButton.evaluate((element: HTMLElement) => ({
      className: element.className,
      background: getComputedStyle(element).backgroundColor,
      color: getComputedStyle(element).color,
    }));
    evidence.onStyle = style;
    assert.notEqual(style.background, 'rgba(0, 0, 0, 0)');
    assert(!style.background.startsWith('rgba(255, 255, 255'), style.background);
    const said = JSON.parse(
      (await mcp({ name: 'neo.speech.say', input: { requestId: 'button-1', text: 'Synthetic spoken reply.' } }))
        .content[0].text
    ) as { ok: boolean; id: string };
    assert(said.ok, JSON.stringify(said));
    await wait(() => receipts().some((row) => row.id === said.id && row.state === 'played'));
    const states = receipts()
      .filter((row) => row.id === said.id)
      .map((row) => row.state);
    await stopButton.click();
    await button.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
    const after = JSON.parse(
      (await mcp({ name: 'neo.speech.say', input: { requestId: 'button-2', text: 'Nobody is listening.' } }))
        .content[0].text
    ) as { ok: boolean; reason?: string };
    assert(!after.ok && String(after.reason).startsWith('voice_replies_off'), JSON.stringify(after));
    Object.assign(evidence, { passed: true, receipts: states, offAfterStop: after.reason });
  }
  console.log(JSON.stringify(evidence));
} finally {
  writeFileSync(join(run, 'evidence/neo-live-voice-button.json'), JSON.stringify(evidence, null, 2));
  if (!evidence.passed) await page?.screenshot({ path: join(run, 'evidence/failure.png') }).catch(() => {});
  await browser?.close();
  front?.stop(true);
  tts.closeAllConnections();
  await new Promise<void>((done) => tts.close(() => done()));
  await app.cleanup();
  globalThis.fetch = network;
}
