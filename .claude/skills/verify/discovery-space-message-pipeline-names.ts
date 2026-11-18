import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';

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
  const space = new SpaceRepository(app.db.getDatabase()).createSpace({ slug: 'discovery-fixture', name: 'Discovery', workspacePath: join(run, 'workspace') });
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
  const calls: [string, object][] = [
    ['operations.list', { query: 'space.get' }],
    ['operations.describe', { name: 'space.get' }],
    ['operations.describe', { name: 'missing.operation' }],
    ['space.list', {}],
    ['space.get', { spaceId: space.id }],
    ['space.get', { spaceId: 'missing' }],
    ['message.send', { to: 'missing', text: 'Synthetic proof' }],
    ['message.status', { sessionId: 'missing', messageId: 'missing' }],
    ['send_message', { target: 'missing', message: 'Synthetic proof' }],
  ];
  for (const [operation, input] of calls) await invoke(operation, input);
  assert.equal(replies.length, calls.length);
  assert((replies[0].data as { name: string }[]).some((item) => item.name === 'space.get'));
  assert.equal((replies[1].data as { found: boolean }).found, true);
  assert.deepEqual(replies[2].data, { found: false, name: 'missing.operation' });
  assert.equal((replies[3].data as { spaces: unknown[] }).spaces.length, 1);
  assert.equal((replies[4].data as { found: boolean }).found, true);
  assert.deepEqual(replies[5].data, { found: false, spaceId: 'missing' });
  assert.deepEqual(replies[6].data, { kind: 'rejected', reason: 'Unknown session: missing' });
  assert.deepEqual(replies[7].data, { status: 'unknown' });
  assert.equal(replies[8].data, 'not_a_node_agent');
  console.log(`ok: ${replies.length} authenticated RPC replies`);
} finally {
  ws?.close(); await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/discovery-space-message-pipeline-names.json'), JSON.stringify(replies, null, 2));
}
