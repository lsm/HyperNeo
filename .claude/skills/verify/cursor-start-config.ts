import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkDetail, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const [portText, run] = process.argv.slice(2);
const port = Number(portText);
assert(run && Number.isInteger(port) && port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const cliDir = join(run, 'bin');
const journal = join(run, 'evidence/cursor-acp.jsonl');
const workspace = join(run, 'workspace');
mkdirSync(cliDir, { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(journal, '');
writeFileSync(
  join(cliDir, 'cursor-agent'),
  `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv[2] !== 'acp') process.exit(2);
let model = 'default';
const efforts = { 'claude-opus-5-5': 'medium', 'gpt-5.5': 'high' };
let parameterized = false;
const select = (id, category, currentValue, values) => ({ id, category, type: 'select', currentValue,
  options: values.map((value) => ({ value, name: value })) });
const configOptions = () => [
  select('model', 'model', model, ['default', 'claude-opus-5-5', 'gpt-5.5']),
  ...(parameterized && efforts[model] ? [select('effort', 'thought_level', efforts[model], ['low', 'medium', 'high'])] : []),
];
const emit = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  appendFileSync(${JSON.stringify(journal)}, JSON.stringify(frame) + '\\n');
  const { id, method, params } = frame;
  if (method === 'initialize') parameterized = params.clientCapabilities?._meta?.parameterizedModelPicker === true;
  if (method === 'initialize') emit({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (method === 'session/new') emit({ id, result: { sessionId: 'cursor-' + Date.now(), configOptions: configOptions() } });
  else if (method === 'session/set_config_option') {
    const values = params.configId === 'model' ? ['default', 'claude-opus-5-5', 'gpt-5.5'] : ['low', 'medium', 'high'];
    if (!parameterized || !values.includes(params.value))
      emit({ id, error: { code: -32602, message: 'Invalid params', data: { message: 'Invalid model value: ' + params.value } } });
    else {
      if (params.configId === 'effort') efforts[model] = params.value;
      else if (params.value !== 'gpt-5.5') model = params.value;
      emit({ id, result: { configOptions: configOptions() } });
    }
  } else if (method === 'session/prompt') {
    emit({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from ' + model + ' at ' + (efforts[model] ?? 'no effort') } } } });
    emit({ id, result: { stopReason: 'end_turn' } });
  } else emit({ id, error: { code: -32601, message: 'Method not found' } });
}
`,
  { mode: 0o700 }
);
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.chdir(run);
const app = await createDaemonApp({
  config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
let socket: WebSocket | undefined;
let calls = 0;
try {
  const ws = createLocalSocket(`ws://127.0.0.1:${port}/ws`);
  socket = ws;
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Isolated RPC connection failed'));
  });
  async function rpc<T>(name: string, input: object): Promise<T> {
    calls++;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} timed out`)), 20_000);
      const receive = (event: MessageEvent) => {
        const reply = JSON.parse(String(event.data));
        if (reply.id !== id && reply.requestId !== id) return;
        clearTimeout(timer);
        ws.removeEventListener('message', receive);
        if (reply.error) reject(new Error(JSON.stringify(reply.error)));
        else resolve(reply.data);
      };
      ws.addEventListener('message', receive);
      ws.send(
        JSON.stringify({
          id, type: 'REQ', sessionId: 'global', method: 'operation.invoke',
          data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0',
        })
      );
    });
  }
  const adapter = 'cursor-cli';
  let frames: { method: string; params?: { configId?: string; value?: string } }[] = [];
  const methods = () => {
    const lines = readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean);
    writeFileSync(journal, '');
    frames = lines.map((line) => JSON.parse(line));
    return frames.map(({ method }) => method);
  };
  const restored = () => frames.at(-1)?.params;
  const results: Record<string, unknown> = {};
  const listed = await rpc<Result<{ id: string; capabilities: string[]; identity?: object }[]>>('work.adapters', {});
  assert(listed.ok);
  const cursor = listed.value.find((entry) => entry.id === adapter);
  assert.deepEqual(cursor?.identity, { fixedProvider: 'cursor', configurable: true });
  assert(cursor?.capabilities.includes('start'));
  results.adapter = cursor;
  const { description } = await rpc<{ description: string }>('operations.describe', { name: 'work.start' });
  assert.match(description, /Cursor CLI accepts model and effort on new sessions/);
  const input = {
    adapter,
    place: { machine: hostname(), folder: workspace, name: 'Fixture workspace' },
    title: 'Fixture work',
    message: 'Reply with a greeting.',
  };
  const start = (model: string, effort?: string) =>
    rpc<Result<WorkStarted>>('work.start', { ...input, model, ...(effort ? { effort } : {}) });

  const started = await start('claude-opus-5-5', 'high');
  assert(started.ok, JSON.stringify(started));
  assert.deepEqual([started.value.model, started.value.effort], ['claude-opus-5-5', 'high']);
  let settled = await rpc<Result<WorkDetail>>('work.status', { ref: started.value.ref });
  for (let tries = 0; settled.ok && settled.value.status === 'running' && tries < 200; tries++) {
    await Bun.sleep(25);
    settled = await rpc<Result<WorkDetail>>('work.status', { ref: started.value.ref });
  }
  assert(settled.ok && settled.value.status === 'done', JSON.stringify(settled));
  assert.deepEqual([settled.value.model, settled.value.effort], ['claude-opus-5-5', 'high']);
  assert.equal(settled.value.lastReply, 'Hello from claude-opus-5-5 at high');
  assert.deepEqual(methods(), [
    'initialize', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt',
  ]);
  results.started = { model: settled.value.model, effort: settled.value.effort, lastReply: settled.value.lastReply };

  const effort = await start('claude-opus-5-5', 'max');
  assert(!effort.ok && effort.notSent && effort.reason === 'unsupported_effort', JSON.stringify(effort));
  assert.deepEqual(methods(), ['initialize', 'session/new', 'session/set_config_option', 'session/set_config_option']);
  assert.deepEqual([restored()?.configId, restored()?.value], ['model', 'default']);
  results.unsupportedEffort = effort;

  const model = await start('claude-opus-9');
  assert(!model.ok && model.notSent && model.reason === 'unsupported_model', JSON.stringify(model));
  assert.deepEqual(methods(), ['initialize', 'session/new']);
  results.unsupportedModel = model;

  const unconfirmed = await start('gpt-5.5', 'high');
  assert(!unconfirmed.ok && unconfirmed.notSent && unconfirmed.reason === 'not_delivered', JSON.stringify(unconfirmed));
  assert.deepEqual(methods(), ['initialize', 'session/new', 'session/set_config_option', 'session/set_config_option']);
  assert.deepEqual([restored()?.configId, restored()?.value], ['model', 'default']);
  results.unconfirmed = unconfirmed;

  writeFileSync(join(run, 'evidence/cursor-start-config.json'), JSON.stringify({ calls, ...results }, null, 2));
  process.stdout.write(JSON.stringify({ calls, passed: 4 }) + '\n');
} finally {
  socket?.close();
  await app.cleanup();
}
