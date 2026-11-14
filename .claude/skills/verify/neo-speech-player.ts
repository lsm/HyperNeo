process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
for (const dir of ['workspace', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
const network = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'external network disabled');
  return network(input, init);
}) as typeof fetch;

const RATE = 24000;
const seconds = (text: string) => (text.startsWith('Long') ? 3 : 0.6);
const tts = createServer(async (request, response) => {
  if (request.url !== '/v1/audio/speech') return void response.writeHead(404).end('{}');
  let body = '';
  for await (const part of request) body += part;
  const samples = Math.round(seconds(JSON.parse(body).input) * RATE);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    pcm.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / RATE) * 16000), i * 2);
  response.writeHead(200, { 'Content-Type': 'audio/pcm' });
  for (let offset = 0; offset < pcm.length && !response.destroyed; offset += 1001) {
    response.write(pcm.subarray(offset, offset + 1001));
    await new Promise((done) => setTimeout(done, 5));
  }
  response.end();
});
await new Promise<void>((done) => tts.listen(0, '127.0.0.1', done));
process.env.HYPERNEO_SPEECH_URL = `http://127.0.0.1:${(tts.address() as AddressInfo).port}`;

const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
assert.notEqual(app.server.port, 8499);
const sessionId = 'neo:10000000-0000-4000-8000-000000000001';
await app.spaceRuntimeService.ready();
await app.jobProcessor.stop();
const now = new Date().toISOString();
await app.db.createSession({
  id: sessionId,
  title: 'Public speech player fixture',
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
const speak = async (requestId: string, text: string) =>
  JSON.parse((await mcp({ name: 'neo.speech.say', input: { requestId, text } })).content[0].text) as {
    ok: boolean;
    id: string;
  };
const receipts = (id: string) =>
  (
    app.db
      .getDatabase()
      .prepare("SELECT reason FROM operation_refusals WHERE operation='neo.speech' ORDER BY rowid")
      .all() as { reason: string }[]
  )
    .map((row) => JSON.parse(row.reason) as { id: string; state: string })
    .filter((row) => row.id === id)
    .map((row) => row.state);
const wait = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 1500 && !(await check()); i++) await new Promise((done) => setTimeout(done, 20));
  assert(await check());
};

const playerBundle = join(run, 'player-entry.ts');
writeFileSync(
  playerBundle,
  `import { openNeoSpeechPlayer } from ${JSON.stringify(resolve('packages/web/src/lib/voice/neo-speech-player.ts'))};
const w = window as any;
w.acks = []; w.voiced = 0; w.peak = 0;
const hub = { request: (method: string, data: any) => { w.acks.push({ ...data.input, at: performance.now() }); return w.hubRequest(method, data); },
  onEvent: (_method: string, handler: any) => { w.deliver = handler; return () => { w.deliver = null; }; } };
w.player = openNeoSpeechPlayer(hub as any, ${JSON.stringify(sessionId)}, { createContext: () => {
  const context = new AudioContext();
  const tap = context.createGain();
  const meter = context.createScriptProcessor(1024, 1, 1);
  meter.onaudioprocess = (event) => { for (const sample of event.inputBuffer.getChannelData(0)) { if (Math.abs(sample) > 0.05) w.voiced++; w.peak = Math.max(w.peak, Math.abs(sample)); } };
  tap.connect(context.destination); tap.connect(meter); meter.connect(context.destination);
  w.contextRate = context.sampleRate;
  return { get currentTime() { return context.currentTime; }, destination: tap,
    createBuffer: context.createBuffer.bind(context), createBufferSource: context.createBufferSource.bind(context),
    close: () => context.close() } as unknown as AudioContext;
} });`
);
const built = await Bun.build({ entrypoints: [playerBundle], target: 'browser' });
assert(built.success);
const script = await built.outputs[0].text();

const requireFrom = createRequire(join(process.env.NODE_PATH || run, 'noop.js'));
const { chromium } = requireFrom('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.VERIFY_BROWSER || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  createSocket: createLocalSocket,
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
});
let evidence: Record<string, unknown> = { passed: false };
try {
  hub.registerTransport(transport);
  await transport.initialize();
  const page = await browser.newPage();
  await page.exposeFunction('hubRequest', (method: string, data: unknown) => hub.request(method, data));
  await page.setContent('<html><body>speech player proof</body></html>');
  await page.addScriptTag({ content: script });
  let forwarding = Promise.resolve();
  const types: string[] = [];
  hub.onEvent('neo.speech', (event: { type: string }) => {
    types.push(event.type);
    forwarding = forwarding.then(() => page.evaluate((data) => (window as any).deliver?.(data), event));
  });
  await hub.request('operation.invoke', { name: 'neo.open', input: {} });
  const listen = await hub.request<{ ok: boolean }>('operation.invoke', {
    name: 'neo.speech.listen',
    input: { sessionId, enabled: true, audio: true },
  });
  assert(listen.ok);

  const short = await speak('short', 'Short public reply.');
  assert(short.ok);
  await wait(() => receipts(short.id).includes('played'));
  const played = await page.evaluate(() => ({
    acks: (window as any).acks,
    voiced: (window as any).voiced,
    peak: (window as any).peak,
    rate: (window as any).contextRate,
  }));
  const playing = played.acks.find((ack: { state: string }) => ack.state === 'playing');
  const done = played.acks.find((ack: { state: string }) => ack.state === 'played');
  const heldMs = done.at - playing.at;
  assert(heldMs >= 550, `played after ${heldMs}ms`);
  assert(played.voiced >= 0.5 * played.rate, `voiced samples ${played.voiced}`);

  const long = await speak('long', 'Long public reply.');
  await wait(() => receipts(long.id).includes('playing'));
  await page.evaluate(() => (window as any).player.interrupt());
  await wait(() => receipts(long.id).includes('cancelled'));
  const interruptedAt = await page.evaluate(() => (window as any).voiced);
  await new Promise((wait) => setTimeout(wait, 600));
  const afterInterrupt = await page.evaluate(() => (window as any).voiced);
  assert(afterInterrupt - interruptedAt < 0.05 * played.rate, 'audio kept playing after interrupt');

  evidence = {
    passed: true,
    realDaemon: true,
    realWebSocket: true,
    realChromiumWebAudio: true,
    chunks: types.filter((type) => type === 'audio').length,
    short: { receipts: receipts(short.id), heldMs: Math.round(heldMs), voicedSamples: played.voiced, peak: played.peak },
    long: { receipts: receipts(long.id), voicedAfterInterrupt: afterInterrupt - interruptedAt },
  };
  console.log(JSON.stringify(evidence));
} finally {
  writeFileSync(join(run, 'evidence/neo-speech-player.json'), JSON.stringify(evidence, null, 2));
  await browser.close();
  await transport.close();
  hub.cleanup();
  tts.closeAllConnections();
  await new Promise<void>((done) => tts.close(() => done()));
  await app.cleanup();
  globalThis.fetch = network;
}
