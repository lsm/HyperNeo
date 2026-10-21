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
writeFileSync(cliPath, `#!/usr/bin/env bun\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const worker = await openCopilotWorker({ cliPath, expectedVersion: 'fixture-1', sessionId: '11111111-1111-4111-8111-111111111111', cwd: join(run, 'workspace'), stateDirectory: join(run, 'state'), model: 'synthetic-model', env: process.env, timeoutMs: 2000 });
const evidence: unknown[] = [];
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  app.messageHub.onRequest('verify.copilot', async (data: { action: string }) => {
    if (data.action === 'hold') return { receipt: await worker.submit('hold'), state: await worker.snapshot() };
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
  const held = await rpc('verify.copilot', { action: 'hold' }) as { receipt: { inputId: string }; state: Awaited<ReturnType<typeof worker.snapshot>> };
  assert.equal(held.state.status, 'running');
  assert.equal(held.state.inputs[held.receipt.inputId].replyAvailability, 'incomplete');
  const finished = await rpc('verify.copilot', { action: 'finish' }) as typeof held;
  assert.equal(finished.state.status, 'done');
  assert.equal(finished.state.inputs[held.receipt.inputId].replyReport, 'FIRST_REPLY');
  assert.equal(finished.state.inputs[held.receipt.inputId].replyAvailability, 'complete');
  assert(!JSON.stringify(finished).includes('UNRELATED'));
  const adapters = await rpc('operation.invoke', { name: 'work.adapters', input: {} }) as { value: { id: string; capabilities: string[] }[] };
  assert.deepEqual(adapters.value.find(a => a.id === 'copilot-cli')?.capabilities, ['find']);
  const calls = readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(calls.every(call => !call.secretPresent));
  evidence.push({ sdkProtocolCalls: calls });
  console.log(`PASS: owned SDK runtime over isolated daemon test RPC; attributed replies, no premature completion; work adapters stay find-only. ${run}/evidence/observed.json`);
} finally {
  ws?.close();
  await worker.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
