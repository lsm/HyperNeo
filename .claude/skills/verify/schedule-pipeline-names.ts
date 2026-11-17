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
  const space = new SpaceRepository(app.db.getDatabase()).createSpace({ slug: 'schedule-fixture', name: 'Schedules', workspacePath: join(run, 'workspace') });
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const invoke = (operation: string, input: object) => new Promise<{ ok: boolean; reason?: string; schedule: { id: string; status: string }; schedules: unknown[] }>((done, fail) => {
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
  const created = await invoke('schedule.create', { spaceId: space.id, title: 'Schedule proof', description: 'RPC comparison', triggerType: 'at', runAt: 4102444800000 });
  assert.equal(created.ok, true);
  const scheduleId = created.schedule.id as string;
  const ref = { spaceId: space.id, scheduleId };
  const listed = await invoke('schedule.list', { spaceId: space.id });
  assert.equal(listed.ok, true); assert.equal(listed.schedules.length, 1);
  const fetched = await invoke('schedule.get', ref); assert.deepEqual(fetched.schedule, created.schedule);
  const updated = await invoke('schedule.update', { ...ref, status: 'paused' }); assert.equal(updated.schedule.status, 'paused');
  const deleted = await invoke('schedule.delete', ref); assert.deepEqual(deleted, { ok: true });
  for (const operation of ['schedule.get', 'schedule.update', 'schedule.delete']) {
    const result = await invoke(operation, { ...ref, ...(operation === 'schedule.update' ? { status: 'paused' } : {}) });
    assert.equal(result.ok, false); assert.equal(result.reason, 'schedule_not_found');
  }
  const empty = await invoke('schedule.list', { spaceId: space.id }); assert.deepEqual(empty, { ok: true, schedules: [] });
  console.log(`ok: ${replies.length} schedule RPC replies including missing records`);
} finally {
  ws?.close(); await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/schedule-pipeline-names.json'), JSON.stringify(replies, null, 2));
}
