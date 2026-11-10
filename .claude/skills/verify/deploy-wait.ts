import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import type { QueryRunner } from '../../../packages/daemon/src/lib/agent/query-runner.ts';
import type { ProcessingStateManager } from '../../../packages/daemon/src/lib/agent/processing-state-manager.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const network = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'external requests disabled');
  return network(input, init);
}) as typeof fetch;
const cases: Record<string, unknown>[] = [];
let restarts = 0;
let passed = false;
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1',
  dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true }, verbose: false });
let socket: ReturnType<typeof createLocalSocket> | undefined;
try {
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  await app.spaceRuntimeService.ready();
  const repo = new NeoRepository(app.db.getDatabase());
  const id = repo.defaultBinding()?.sessionId ?? 'neo:10000000-0000-4000-8000-000000000001';
  if (!app.db.getSession(id)) await app.db.createSession({ id, title: 'Restart fixture', workspacePath: run,
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0,
      outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  repo.reserveBinding({ sessionId: id, kind: 'neo', projectId: null });
  const session = await app.sessionManager.getSession(id);
  const state = (session as unknown as { stateManager: ProcessingStateManager }).stateManager;
  await state.setIdle();
  socket = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`, join(run, 'data/local-rpc.credential'));
  const speechIds: string[] = [];
  socket.on('message', (raw) => { const frame = JSON.parse(String(raw));
    if (frame.method === 'neo.speech' && frame.data?.type === 'say') speechIds.push(frame.data.id); });
  await new Promise<void>((done, fail) => { socket!.once('open', done); socket!.once('error', fail); });
  const rpc = <T>(method: string, data: unknown) => new Promise<T>((done, fail) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { socket!.off('message', receive); fail(new Error(`${method} timeout`)); }, 10_000);
    const receive = (raw: unknown) => { const frame = JSON.parse(String(raw));
      if ((frame.requestId ?? frame.id) !== requestId) return;
      clearTimeout(timer); socket!.off('message', receive);
      if (frame.error) fail(new Error(frame.error.message ?? JSON.stringify(frame.error))); else done(frame.data); };
    socket!.on('message', receive);
    socket!.send(JSON.stringify({ id: requestId, type: 'REQ', method, data, sessionId: 'global',
      timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const operation = <T>(name: string, input: unknown) => rpc<T>('operation.invoke', { name, input });
  const reserve = async () => {
    const child = spawnProcess([process.execPath, resolve('packages/cli/main.ts'), 'reserve-restart'], {
      stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HYPERNEO_SESSION_DOOR: join(run, 'data/session-door.sock') },
    });
    const text = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    const code = await child.exited;
    assert(text.trim(), error);
    return { code, value: JSON.parse(text) as { ok: boolean; reason?: string; pid?: number; expiresAt?: number } };
  };
  const refused = async (name: string, reason: string) => {
    const result = await reserve();
    assert.equal(result.code, 1); assert.equal(result.value.reason, reason);
    cases.push({ name, restarts, reason }); assert.equal(restarts, 0);
  };
  await rpc('settings.global.update', { updates: { voice: { enabled: true, mode: 'batch',
    endpoint: 'http://127.0.0.1:1/transcriptions', model: 'fixture', allowPrivateNetwork: true } } });
  const stream = await rpc<{ streamId: string }>('voice.stream.start', { encoding: 'pcm16', sampleRate: 16000 });
  await refused('open microphone', 'voice_busy');
  await rpc('voice.stream.cancel', stream);
  await operation('neo.speech.listen', { sessionId: id, enabled: true, audio: true });
  await refused('capture rotation gap with listener', 'voice_busy');
  await operation('neo.speech.listen', { sessionId: id, enabled: false });
  await operation('neo.speech.listen', { sessionId: id, enabled: true });
  const spoken = await invokeOperation(app.sessionManager.getOperationRegistry(), 'neo.speech.say',
    { requestId: 'fixture-speech', text: 'Synthetic speech fixture' }, { source: 'mcp', role: 'neo', sessionId: id });
  assert.equal(spoken.kind, 'completed');
  const speech = (spoken as { value: { id: string; ok: boolean } }).value;
  assert(speech.ok);
  await refused('queued speech', 'voice_busy');
  await operation('neo.speech.ack', { sessionId: id, id: speech.id, state: 'playing' });
  await refused('playing speech', 'voice_busy');
  await operation('neo.speech.ack', { sessionId: id, id: speech.id, state: 'played' });
  await state.setProcessing('fixture-turn');
  await refused('busy Neo turn', 'neo_busy');
  await state.setIdle();
  const clear = await reserve();
  assert.equal(clear.code, 0); assert(clear.value.ok);
  assert.equal(clear.value.pid, process.pid); assert(clear.value.expiresAt! > Date.now());
  restarts++;
  cases.push({ name: 'all clear with text-only listener and old receipt', restarts });
  await assert.rejects(rpc('voice.stream.start', {}), /updating/i);
  const listen = await operation<{ ok: boolean; reason: string; retryable: boolean }>('neo.speech.listen',
    { sessionId: id, enabled: true, audio: true });
  assert.deepEqual(listen, { ok: false, reason: 'updating', retryable: true });
  session.messageQueue.clear();
  const inputId = crypto.randomUUID();
  await app.db.writeSDKMessage('saveUserMessage', id, { type: 'user', uuid: inputId,
    session_id: id, parent_tool_use_id: null, message: { role: 'user', content: 'Retained input' } }, 'enqueued');
  await state.setQueued(inputId);
  session.messageQueue.start();
  const admitted = session.messageQueue.enqueueWithId(inputId, 'Retained input', false, { durable: true });
  const runner = (session as unknown as { queryRunner: QueryRunner }).queryRunner;
  const feed = runner.createMessageGeneratorWrapper(0);
  const pending = feed.next();
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(state.getState().status, 'queued');
  assert(app.db.getMessageByStatusAndUuid(id, 'enqueued', inputId));
  const yielded = await pending;
  assert(!yielded.done);
  assert(JSON.stringify(yielded.value.message.content).includes('Retained input'));
  assert(app.db.getMessageByStatusAndUuid(id, 'consumed', inputId));
  assert.equal(state.getState().status, 'processing');
  const end = feed.next();
  session.messageQueue.stop();
  await end;
  await admitted;
  cases.push({ name: 'reservation wins race, voice refuses and Neo input waits until expiry', restarts });
  assert.equal(restarts, 1);
  passed = true;
} finally {
  socket?.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/deploy-wait.json'), JSON.stringify({ passed, restarts,
    cases, resourcesClosed: true }, null, 2));
}
console.log(`PASS ${cases.length} deploy reservation cases, fake restarts=${restarts}`);
