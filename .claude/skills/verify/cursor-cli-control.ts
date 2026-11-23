import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkDelivery, WorkDetail, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const [binary, run] = process.argv.slice(2);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const bin = join(run, 'home/.local/bin');
const folder = join(run, 'workspace');
mkdirSync(folder);
mkdirSync(bin, { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const executable = join(bin, 'cursor-agent');
if (binary !== '-') symlinkSync(binary, executable);
else writeFileSync(executable, `#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
assert.deepEqual(process.argv.slice(2), ['--sandbox', 'enabled', 'acp']);
const sessionId = 'fixture-cursor-cli';
const config = (currentValue) => ({ configOptions: [{ id: 'model', category: 'model', currentValue }] });
const write = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
let held;
let loaded = false;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') write({ id, result: { protocolVersion: 1 } });
  else if (method === 'session/new') write({ id, result: { sessionId, ...config('default') } });
  else if (method === 'session/set_config_option') write({ id, result: config(params.value === 'unavailable' ? 'default' : params.value) });
  else if (method === 'session/load') {
    assert.equal(params.sessionId, sessionId);
    loaded = true;
    write({ id, result: config('fixture-model') });
  } else if (method === 'session/prompt') {
    const text = params.prompt[0].text;
    if (text === 'hold') assert(loaded);
    write({ method: 'session/update', params: {
      sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply ' + text } },
    } });
    if (text === 'hold') held = id;
    else write({ id, result: { stopReason: 'end_turn' } });
  } else if (method === 'session/cancel') {
    assert.equal(params.sessionId, sessionId);
    assert(held);
    write({ id: held, result: { stopReason: 'cancelled' } });
  } else throw new Error(method);
}
`, { mode: 0o700 });

const app = await createDaemonApp({
  config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: folder }), disableGoalProcessing: true },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
let closed = Promise.resolve();
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: (url) => {
    const socket = createLocalSocket(url);
    closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
    return socket;
  },
});
hub.registerTransport(transport);
let calls = 0;
function rpc<T>(name: string, input: object): Promise<T> {
  calls++;
  return hub.request<T>('operation.invoke', { name, input });
}
try {
  assert(![8399, 8499].includes(app.server.port));
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.connect();
  const adapter = 'cursor-cli';
  const args = { adapter, place: { machine: hostname(), name: 'Fixture', folder }, title: 'Cursor fixture', message: 'start', inPlace: true };
  if (binary !== '-') {
    const refused = await rpc<Result<WorkStarted>>('work.start', args);
    assert(!refused.ok && refused.reason === 'not_delivered' && refused.detail.includes('sign-in'));
  } else {
    const misleading = await rpc<Result<WorkStarted>>('work.start', { ...args, model: 'unavailable' });
    assert(!misleading.ok && misleading.detail.includes('confirm the requested model'));
    const result = await rpc<Result<WorkStarted>>('work.start', { ...args, model: 'fixture-model' });
    assert(result.ok, JSON.stringify(result));
    const { ref, receipt, model } = result.value;
    assert(receipt && model === 'fixture-model');
    let status: Result<WorkDetail>;
    do {
      status = await rpc<Result<WorkDetail>>('work.status', { ref, receipt });
      if (!status.ok || status.value.status !== 'running') break;
      await Bun.sleep(75);
    } while (calls < 20);
    assert(status.ok && status.value.status === 'done' && status.value.lastReply === 'reply start');
    assert(status.value.inputEvidence?.state === 'observed');
    const send = await rpc<Result<WorkDelivery>>('work.send', { ref, message: 'hold' });
    assert(send.ok && send.value.delivered && send.value.receipt);
    const busy = await rpc<Result<WorkDelivery>>('work.send', { ref, message: 'must not run' });
    assert(!busy.ok && busy.reason === 'busy');
    const stop = await rpc<Result<{ stopped: boolean }>>('work.stop', { ref });
    assert(stop.ok && stop.value.stopped);
    const stopped = await rpc<Result<WorkDetail>>('work.status', { ref, receipt: send.value.receipt });
    assert(stopped.ok && stopped.value.status === 'stopped');
  }
  process.stdout.write(`Cursor CLI lifecycle: ${calls} RPC calls, result confirmed\n`);
} finally {
  await transport.close();
  await closed;
  hub.cleanup();
  await app.cleanup();
}
