import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
const phase = process.argv[2];
assert(['before', 'after'].includes(phase));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const folder of ['workspace', 'evidence']) mkdirSync(join(run, folder), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const receipts: unknown[] = [];
let active = { id: '', text: '', received: 0, bytes: 0, held: false, route: '' };
let release: (() => void) | undefined;
let observed = () => ({ receipts, durable: [] as unknown[] });
let configureMode: (streaming: boolean) => Promise<void>;
const streamFinal = (text: string, isFinal: boolean) =>
  JSON.stringify({
    type: 'Results',
    is_final: isFinal,
    channel: { alternatives: [{ transcript: text }] },
  });
const asr = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === '/stream') {
      if (server.upgrade(request, { data: { current: active } })) return;
      return new Response('Upgrade failed', { status: 500 });
    }
    if (path === '/mode') {
      const input = (await request.json()) as { streaming: boolean };
      await configureMode(input.streaming);
      return Response.json({ ok: true });
    }
    if (path === '/arm') {
      assert(!release, 'Previous ASR request must finish before the next case');
      const input = (await request.json()) as { id: string; text: string };
      active = { ...input, received: 0, bytes: 0, held: false, route: '' };
      return Response.json({ ok: true });
    }
    if (path === '/stats') return Response.json(active);
    if (path === '/release') {
      release?.();
      return Response.json({ ok: true });
    }
    if (path === '/observed') return Response.json(observed());
    assert.equal(path, '/asr');
    const form = await request.formData();
    const audio = form.get('file');
    assert(audio instanceof Blob);
    const current = active;
    current.route = 'batch';
    current.received++;
    current.bytes += audio.size;
    current.held = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    release = undefined;
    current.held = false;
    return Response.json({ text: current.text });
  },
  websocket: {
    data: {} as { current: typeof active },
    open(socket) {
      socket.data.current.route = 'streaming';
      socket.data.current.received++;
    },
    message(socket, message) {
      const current = socket.data.current;
      if (typeof message !== 'string') {
        current.bytes += message.byteLength;
        socket.send(streamFinal('Interim speech', false));
        return;
      }
      if (JSON.parse(message).type === 'CloseStream') {
        current.held = true;
        release = () => {
          release = undefined;
          current.held = false;
          socket.send(streamFinal(current.text, true));
          socket.close(1000);
        };
      }
    },
  },
});
assert(![8399, 8499].includes(asr.port!));
const app = await createDaemonApp({
  config: {
    ...getConfig({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: join(run, 'workspace'),
    }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
let closed = Promise.resolve();
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: (url) => {
    const socket = createLocalSocket(url);
    closed = new Promise<void>((resolve) =>
      socket.addEventListener('close', () => resolve(), { once: true })
    );
    return socket;
  },
});
hub.registerTransport(transport);
let front: ReturnType<typeof Bun.serve> | undefined;
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  await transport.connect();
  const root = `neo:${crypto.randomUUID()}`;
  const conversationId = root.slice(4);
  const publicationId = crypto.randomUUID();
  const at = new Date().toISOString();
  await app.db.createSession({
    id: root,
    title: 'Synthetic voice send',
    workspacePath: join(run, 'workspace'),
    createdAt: at,
    lastActiveAt: at,
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0 },
  });
  const raw = app.db.getDatabase();
  new NeoRepository(raw).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  raw
    .prepare(
      'INSERT INTO neo_publications(conversation_id, publication_id, payload_json, created_at) VALUES (?,?,?,?)'
    )
    .run(
      conversationId,
      publicationId,
      JSON.stringify({
        conversationId,
        publicationId,
        askOrigin: { sessionId: root, messageId: crypto.randomUUID() },
        producerInput: { sessionId: root, messageId: crypto.randomUUID() },
        shortText: 'Synthetic quoted message',
        fullText: 'Synthetic quoted message with details.',
        links: [],
      }),
      at
    );
  const registry = app.sessionManager.getOperationRegistry();
  app.sessionManager.setOperationRegistryProvider(() =>
    createOperationRegistry(
      registry.entries.map((operation) =>
        operation.name !== 'neo.message.send'
          ? operation
          : {
              ...operation,
              execute: async (input, caller) => {
                const result = await operation.execute(input, caller);
                receipts.push({ input, result });
                return result;
              },
            }
      )
    )
  );
  observed = () => ({
    receipts,
    durable: raw
      .prepare(
        'SELECT payload_json FROM neo_conversation_asks WHERE conversation_id=? ORDER BY sequence'
      )
      .all(conversationId)
      .map((row) => JSON.parse((row as { payload_json: string }).payload_json)),
  });
  configureMode = async (streaming) => {
    await hub.request('settings.global.update', {
      updates: {
        language: 'en',
        voice: {
          enabled: true,
          endpoint: `http://127.0.0.1:${asr.port}/asr`,
          streamEndpoint: streaming ? `ws://127.0.0.1:${asr.port}/stream` : '',
          model: 'fixture',
          mode: 'streaming',
          allowPrivateNetwork: true,
        },
      },
    });
  };
  await configureMode(false);
  const pair = await hub.request<{ ok: boolean; code: string }>('operation.invoke', {
    name: 'device.pair.create',
    input: { kind: 'human', name: 'Synthetic voice browser' },
  });
  assert(pair.ok);
  const dist = resolve('packages/web/dist');
  assert(existsSync(join(dist, 'neo/index.html')));
  front = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, server) {
      const refused = await app.guardRequest(request);
      if (refused) return refused;
      const path = new URL(request.url).pathname;
      if (path === '/pair' && request.method === 'POST') return app.handlePair(request);
      if (path === '/ws') {
        const device = await app.authenticateUpgrade(request, '127.0.0.1');
        if (!device) return new Response('Pair first', { status: 401 });
        if (server.upgrade(request, { data: { connectionSessionId: 'global', device } })) return;
        return new Response('Upgrade failed', { status: 500 });
      }
      const file = Bun.file(join(dist, path === '/' || path === '/neo' ? 'neo/index.html' : path));
      return new Response((await file.exists()) ? file : Bun.file(join(dist, 'index.html')));
    },
    websocket: createWebSocketHandlers(app.transport, app.sessionManager),
  });
  assert(![8399, 8499].includes(front.port!));
  const pcm = Buffer.alloc(16000 * 2 * 2 + 44);
  pcm.write('RIFF');
  pcm.writeUInt32LE(pcm.length - 8, 4);
  pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(16000, 24);
  pcm.writeUInt32LE(32000, 28);
  pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36);
  pcm.writeUInt32LE(pcm.length - 44, 40);
  for (let i = 0; i < (pcm.length - 44) / 2; i++)
    pcm.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / 16000) * 11000), 44 + i * 2);
  writeFileSync(join(run, 'tone.wav'), pcm);
  writeFileSync(
    join(run, 'browser.json'),
    JSON.stringify({
      base: `http://127.0.0.1:${front.port}`,
      asr: `http://127.0.0.1:${asr.port}`,
      phase,
      publicationId,
      code: pair.code,
    })
  );
  const child = spawn('node', ['.claude/skills/verify/voice-submit-matrix.mjs', run], {
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  clearTimeout(timer);
  assert.equal(code, 0, 'Browser matrix must pass');
} finally {
  writeFileSync(join(run, 'evidence/receipts.json'), JSON.stringify(observed(), null, 2));
  release?.();
  await asr.stop(true);
  await front?.stop(true);
  await transport.close();
  await closed;
  hub.cleanup();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true }));
}
