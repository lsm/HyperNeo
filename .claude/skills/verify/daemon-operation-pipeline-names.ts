import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const [mode, directory] = process.argv.slice(2);
const run = resolve(directory);
assert.equal(mode, 'verify');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP forbidden'); }) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let ws: WebSocket | undefined;
const replies: { operation: string; data: unknown }[] = [];
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const invoke = (operation: string, input: object) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { ws!.removeEventListener('message', listener); fail(new Error(`RPC timeout: ${operation}`)); }, 15000);
    const listener = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); ws!.removeEventListener('message', listener);
      if (reply.error) fail(new Error(JSON.stringify(reply.error)));
      else { replies.push({ operation, data: reply.data }); done(reply.data); }
    };
    ws!.addEventListener('message', listener);
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: operation, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const url = 'ws://127.0.0.1:1/ws';
  const calls: [string, object][] = [
    ['daemon.session.inspect', { sessionId: 'missing' }],
    ['daemon.snapshot', {}],
    ['daemon.list', {}],
    ['daemon.detach', { daemonId: 'missing' }],
    ['daemon.attach', { daemonId: 'fixture', url }],
    ['daemon.list', {}],
    ['daemon.probe', { url }],
    ['daemon.detach', { daemonId: 'fixture' }],
    ['daemon.list', {}],
  ];
  for (const [operation, input] of calls) await invoke(operation, input);
  assert.equal(replies.length, calls.length);
  assert.deepEqual(replies[0].data, { accepted: false, reason: 'session_not_found' });
  assert(Array.isArray((replies[1].data as { resources: unknown[] }).resources));
  assert.deepEqual(replies[2].data, { kind: 'listed', daemons: [] });
  assert.deepEqual(replies[3].data, { kind: 'not_attached', daemonId: 'missing' });
  assert.deepEqual(replies[4].data, { kind: 'attached', daemonId: 'fixture', url, addressExample: 'daemon:fixture::session:<sessionId>' });
  assert.deepEqual(replies[5].data, { kind: 'listed', daemons: [{ daemonId: 'fixture', url, addressExample: 'daemon:fixture::session:<sessionId>' }] });
  assert.equal((replies[6].data as { kind: string }).kind, 'unreachable');
  assert.deepEqual(replies[7].data, { kind: 'detached', daemonId: 'fixture' });
  assert.deepEqual(replies[8].data, { kind: 'listed', daemons: [] });
  console.log(`ok: ${replies.length} authenticated daemon RPC replies`);
} finally {
  ws?.close(); await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/daemon-operation-pipeline-names.json'), JSON.stringify(replies, null, 2));
}
