import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { openCopilotWorker } from '../../../packages/daemon/src/lib/drivers/copilot-worker.ts';

const [portText, runText] = process.argv.slice(2);
assert(runText);
const run = resolve(runText);
const port = Number(portText);
assert(Number.isInteger(port) && port > 0 && port < 65536 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['home', 'bin', 'workspace', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
const fixture = fileURLToPath(new URL('../../../packages/daemon/tests/fixtures/copilot-sdk.ts', import.meta.url));
const cliPath = join(run, 'bin/copilot');
writeFileSync(cliPath, `#!/usr/bin/env bun\nprocess.argv.push('--initial-idle', '--late-user-echo', '--idle-after-abort'); await import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const worker = await openCopilotWorker({ cliPath, expectedVersion: 'fixture-1', sessionId: '11111111-1111-4111-8111-111111111111', cwd: join(run, 'workspace'), stateDirectory: join(run, 'state'), model: 'synthetic-model', env: process.env, timeoutMs: 2000 });
const evidence: unknown[] = [];
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  app.messageHub.onRequest('verify.copilot', async (data: { action: string }) => {
    if (['hold', 'settled', 'permission', 'queued', 'error', 'stale-echo'].includes(data.action)) return { receipt: await worker.submit(data.action), state: await worker.snapshot() };
    if (data.action === 'finish') return { receipt: await worker.submit('finish'), state: await worker.snapshot() };
    if (data.action === 'abort') { await worker.abort(); return worker.snapshot(); }
    return worker.snapshot();
  });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const rpc = (method: string, data: unknown) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error(`${method} timeout`)), 15000);
    ws!.onmessage = event => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); evidence.push({ method, data, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const health = await rpc('system.health', {}) as { status: string };
  assert.equal(health.status, 'ok');
  assert.equal((await rpc('verify.copilot', { action: 'snapshot' }) as { status: string }).status, 'queued');
  const held = await rpc('verify.copilot', { action: 'hold' }) as { receipt: { inputId: string }; state: Awaited<ReturnType<typeof worker.snapshot>> };
  assert.equal(held.state.status, 'running');
  assert.equal(held.state.inputs[held.receipt.inputId].replyAvailability, 'incomplete');
  const finished = await rpc('verify.copilot', { action: 'finish' }) as typeof held;
  assert.equal(finished.state.status, 'done');
  assert.equal(finished.state.inputs[held.receipt.inputId].replyReport, 'FIRST_REPLY');
  assert.equal(finished.state.inputs[held.receipt.inputId].replyAvailability, 'complete');
  assert(!JSON.stringify(finished).includes('UNRELATED'));
  let retained = finished;
  for (let index = 0; index < 270; index++) retained = await rpc('verify.copilot', { action: 'settled' }) as typeof held;
  assert.equal(Object.keys(retained.state.inputs).length, 64);
  assert.equal(retained.state.inputs[held.receipt.inputId], undefined);
  assert.equal(retained.state.inputs[retained.receipt.inputId].replyAvailability, 'complete');
  const replay = await rpc('verify.copilot', { action: 'stale-echo' }) as typeof held;
  assert.equal(replay.state.status, 'done');
  assert.equal(replay.state.inputs[replay.receipt.inputId].replyReport, 'STALE_SAFE_REPLY');
  const queued = await rpc('verify.copilot', { action: 'queued' }) as typeof held;
  assert.equal(queued.state.inputs[queued.receipt.inputId].state, 'pending');
  const interrupted = await rpc('verify.copilot', { action: 'hold' }) as typeof held;
  await rpc('verify.copilot', { action: 'abort' });
  let stopped = await rpc('verify.copilot', { action: 'snapshot' }) as typeof held.state;
  for (let poll = 0; poll < 100 && stopped.status !== 'stopped'; poll++) {
    await new Promise(done => setTimeout(done, 10));
    stopped = await rpc('verify.copilot', { action: 'snapshot' }) as typeof stopped;
  }
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.inputs[interrupted.receipt.inputId].outcome, 'stopped');
  assert.equal(stopped.inputs[queued.receipt.inputId].outcome, 'stopped');
  assert.equal(stopped.inputs[queued.receipt.inputId].replyAvailability, 'incomplete');
  assert.equal((await rpc('verify.copilot', { action: 'settled' }) as typeof held).state.status, 'done');
  const beforeError = await rpc('verify.copilot', { action: 'queued' }) as typeof held;
  assert.equal(beforeError.state.inputs[beforeError.receipt.inputId].state, 'pending');
  const failed = await rpc('verify.copilot', { action: 'error' }) as typeof held;
  assert.equal(failed.state.inputs[beforeError.receipt.inputId].outcome, 'failed');
  assert.equal(failed.state.inputs[beforeError.receipt.inputId].replyAvailability, 'incomplete');
  assert.equal((await rpc('verify.copilot', { action: 'settled' }) as typeof held).state.status, 'done');
  const blocked = await rpc('verify.copilot', { action: 'permission' }) as typeof held;
  assert.equal(blocked.state.status, 'needs_you');
  assert.equal(blocked.state.inputs[blocked.receipt.inputId].replyAvailability, 'incomplete');
  await assert.rejects(rpc('verify.copilot', { action: 'hold' }), /permission/);
  assert.equal((await rpc('verify.copilot', { action: 'snapshot' }) as { status: string }).status, 'needs_you');
  const adapters = await rpc('operation.invoke', { name: 'work.adapters', input: {} }) as { value: { id: string; capabilities: string[] }[] };
  assert.deepEqual(adapters.value.find(a => a.id === 'copilot-cli')?.capabilities, ['find', 'start', 'rename', 'send', 'queue', 'status', 'stop', 'archive']);
  const calls = readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(calls.every(call => !call.secretPresent));
  evidence.push({ sdkProtocolCalls: calls });
  console.log(`PASS: isolated daemon SDK RPC; repeated echo keeps reply binding, empty idle queued, bounded receipts, post-abort idle stopped, explicit restart completes, permission stays blocked; public lifecycle capabilities present. ${run}/evidence/observed.json`);
} finally {
  ws?.close();
  await worker.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
