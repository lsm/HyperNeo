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

const [theme, directory] = process.argv.slice(2);
const run = resolve(directory);
assert(['light', 'dark'].includes(theme));
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
  if (request.url === '/v1/audio/transcriptions') {
    for await (const _ of request) {
    }
    return void response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ text: 'Public live voice turn' }));
  }
  if (request.url !== '/v1/audio/speech') return void response.writeHead(404).end('{}');
  let body = '';
  for await (const part of request) body += part;
  const samples = Math.round((JSON.parse(body).input.startsWith('Long') ? 4 : 1) * RATE);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    pcm.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / RATE) * 12000), i * 2);
  response.writeHead(200, { 'Content-Type': 'audio/pcm' });
  response.end(pcm);
});
await new Promise<void>((done) => tts.listen(0, '127.0.0.1', done));
const fixture = `http://127.0.0.1:${(tts.address() as AddressInfo).port}`;
process.env.HYPERNEO_SPEECH_URL = fixture;

const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
const sessionId = 'neo:10000000-0000-4000-8000-000000010600';
const evidence: Record<string, unknown> = { theme, passed: false };
let front: ReturnType<typeof Bun.serve> | undefined;
let browser: { newPage(options?: unknown): Promise<any>; close(): Promise<void> } | undefined;
let page: any;
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await app.settingsManager.updateGlobalSettings({
    language: 'en',
    voice: {
      enabled: true,
      endpoint: `${fixture}/v1/audio/transcriptions`,
      model: 'fixture',
      mode: 'batch',
      allowPrivateNetwork: true,
    },
  });
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
  const inputFacts = () =>
    app.db
      .getSDKMessageRepo()
      .getUserMessages(sessionId)
      .flatMap((row) => {
        const message = app.db.getSDKMessageRepo().getMessageByUuid(sessionId, row.uuid);
        const content = message?.type === 'user' ? message.message.content : [];
        return Array.isArray(content)
          ? content.flatMap((block) =>
              block.type === 'text' && block.text.startsWith('[input:') ? [block.text] : []
            )
          : [];
      });
  const say = async (requestId: string, text: string) =>
    JSON.parse((await mcp({ name: 'neo.speech.say', input: { requestId, text } })).content[0].text) as {
      ok: boolean;
      id: string;
    };
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
  const tone = Buffer.alloc(44 + 48000 * 2 * 3);
  tone.write('RIFF', 0);
  tone.writeUInt32LE(tone.length - 8, 4);
  tone.write('WAVEfmt ', 8);
  tone.writeUInt32LE(16, 16);
  tone.writeUInt16LE(1, 20);
  tone.writeUInt16LE(1, 22);
  tone.writeUInt32LE(48000, 24);
  tone.writeUInt32LE(96000, 28);
  tone.writeUInt16LE(2, 32);
  tone.writeUInt16LE(16, 34);
  tone.write('data', 36);
  tone.writeUInt32LE(tone.length - 44, 40);
  for (let i = 0; i < 48000 * 3; i++)
    tone.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 300) / 48000) * 12000), 44 + i * 2);
  writeFileSync(join(run, 'tone.wav'), tone);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.VERIFY_BROWSER || undefined,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${join(run, 'tone.wav')}`,
    ],
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
  const context = await (browser as any).newContext({
    storageState,
    viewport: { width: 1280, height: 860 },
    colorScheme: theme,
  });
  await context.grantPermissions(['microphone']);
  page = await context.newPage();
  await page.goto(`http://127.0.0.1:${front.port}/neo`);
  const liveButton = page.locator('button[aria-label="Realtime voice"]');
  const stopLive = page.locator('button[aria-label="Stop realtime voice"][aria-pressed="true"]');
  const stopSpeaking = page.locator('button[aria-label="Stop Neo speaking"]');
  const recording = page.locator('button[aria-label="Stop recording and keep the text as a draft"]');
  const sendVoice = page.locator('button[aria-label="Stop recording and send the message"]');
  const settle = async () => {
    await page.mouse.move(0, 0);
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished)
      )
    );
  };
  await liveButton.waitFor({ state: 'visible', timeout: 30_000 });
  await wait(async () => !(await liveButton.isDisabled()));
  await liveButton.click();
  await stopLive.waitFor({ state: 'visible', timeout: 10_000 });
  await recording.waitFor({ state: 'visible', timeout: 10_000 });
  await settle();
  await page.screenshot({ path: join(run, `evidence/listening-${theme}.png`) });

  const short = await say('loop-1', 'Synthetic spoken reply.');
  assert(short.ok, JSON.stringify(short));
  await stopSpeaking.waitFor({ state: 'visible', timeout: 10_000 });
  await recording.waitFor({ state: 'hidden', timeout: 10_000 });
  await settle();
  await page.screenshot({ path: join(run, `evidence/speaking-${theme}.png`) });
  await wait(() => receipts().some((row) => row.id === short.id && row.state === 'played'));
  await recording.waitFor({ state: 'visible', timeout: 15_000 });
  evidence.micReopenedAfterPlayed = true;

  await sendVoice.click();
  await wait(() => inputFacts().includes('[input: live_voice]'));
  await recording.waitFor({ state: 'visible', timeout: 15_000 });
  evidence.inputFacts = inputFacts();
  evidence.micReopenedAfterSend = true;

  const long = await say('loop-2', 'Long synthetic spoken reply.');
  await stopSpeaking.waitFor({ state: 'visible', timeout: 10_000 });
  await stopSpeaking.click();
  await wait(() => receipts().some((row) => row.id === long.id && row.state === 'cancelled'));
  await stopLive.waitFor({ state: 'visible', timeout: 10_000 });
  await recording.waitFor({ state: 'visible', timeout: 15_000 });
  evidence.micReopenedAfterInterrupt = true;
  evidence.receipts = receipts().map((row) => `${row.id === short.id ? 'short' : 'long'}:${row.state}`);
  evidence.passed = true;
  console.log(JSON.stringify(evidence));
} finally {
  writeFileSync(join(run, 'evidence/neo-live-voice-loop.json'), JSON.stringify(evidence, null, 2));
  if (!evidence.passed) await page?.screenshot({ path: join(run, 'evidence/failure.png') }).catch(() => {});
  if (!evidence.passed)
    evidence.refusals = app.db
      .getDatabase()
      .prepare("SELECT operation, reason FROM operation_refusals WHERE operation != 'neo.speech'")
      .all();
  writeFileSync(join(run, 'evidence/neo-live-voice-loop.json'), JSON.stringify(evidence, null, 2));
  await browser?.close();
  front?.stop(true);
  tts.closeAllConnections();
  await new Promise<void>((done) => tts.close(() => done()));
  await app.cleanup();
  globalThis.fetch = network;
}
