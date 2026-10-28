import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { copilotFolder, copilotSession, prepareCopilotFixture } from '../../../packages/daemon/tests/helpers/copilot-fixture.ts';

const [portText, runText] = process.argv.slice(2);
assert(runText);
const run = resolve(runText);
const port = Number(portText);
assert(Number.isInteger(port) && port > 0 && port < 65536 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')), 'fresh synthetic data required');
assert(!existsSync(join(run, 'home/.copilot')), 'fresh synthetic home required');
const { home, bin } = prepareCopilotFixture(run);
assert.equal(process.env.PATH?.split(':')[0], bin);
writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let ws: WebSocket | undefined;
try {
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const rpc = (name: string, input: unknown) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error(`${name} timeout`)), 15000);
    ws!.onmessage = event => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer);
      evidence.push({ name, input, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const adapters = await rpc('work.adapters', {});
  assert(adapters && typeof adapters === 'object' && 'value' in adapters);
  assert.deepEqual((adapters.value as { id: string; capabilities: string[] }[]).find(a => a.id === 'copilot-cli'), { id: 'copilot-cli', capabilities: ['find', 'start', 'rename', 'send', 'queue', 'status', 'stop', 'archive'] });
  const find = await rpc('work.find', { adapters: ['copilot-cli'], folder: copilotFolder, includeClosed: true, localOnly: true });
  assert(find && typeof find === 'object' && 'places' in find);
  const work = (find.places as { work: { ref: { id: string; adapter: string }; title: string }[] }[]).flatMap(p => p.work);
  assert.equal(work.length, 1);
  assert.equal(work[0].ref.id, copilotSession);
  assert.equal(work[0].title, 'Synthetic sum task');
  for (const [name, input] of [
    ['work.send', { ref: work[0].ref, message: 'Do not execute this' }],
    ['work.status', { ref: work[0].ref, receipt: { executionId: copilotSession, inputId: 'unconsumed-input' } }],
    ['work.stop', { ref: work[0].ref }],
  ] as const) {
    const result = await rpc(name, input);
    assert(result && typeof result === 'object' && 'ok' in result && 'reason' in result);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_found');
  }
  const calls = readFileSync(join(home, 'evidence/calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).method);
  assert.deepEqual(calls, ['initialize', 'session/list', 'session/list']);
  evidence.push({ calls, transcript: readFileSync(join(home, '.copilot/session-state', copilotSession, 'events.jsonl'), 'utf8') });
  console.log(`PASS: isolated daemon discovers Copilot; external work remains read-only with no false receipt completion. ${run}/evidence/observed.json`);
} finally {
  ws?.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
