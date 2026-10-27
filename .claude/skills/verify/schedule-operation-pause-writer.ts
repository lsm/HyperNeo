import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import type { TaskSchedule } from '../../../packages/shared/src/types/space.ts';

const [mode, directory] = process.argv.slice(2), run = resolve(directory);
assert.equal(mode, 'verify');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP forbidden'); }) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let ws: WebSocket | undefined, measuring = false;
const replies: unknown[] = [], mainSql: string[] = [];
const raw = app.db.getDatabase(), prepare = raw.prepare.bind(raw);
raw.prepare = ((sql: string) => { if (measuring && (/UPDATE task_schedules[\s\S]*status = 'paused'/.test(sql) || /DELETE FROM job_queue WHERE id =/.test(sql))) mainSql.push(sql); return prepare(sql); }) as typeof raw.prepare;
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const spaces = new SpaceRepository(raw);
  const space = spaces.createSpace({ slug: 'schedule-fixture', name: 'Schedules', workspacePath: join(run, 'workspace') });
  const other = spaces.createSpace({ slug: 'other-fixture', name: 'Other', workspacePath: join(run, 'other') });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const rpc = <T = { schedule: TaskSchedule }>(method: string, data: unknown) => new Promise<T>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 15000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); replies.push({ method, reply }); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const pause = (spaceId: string, scheduleId: string) => rpc<{ ok: boolean; schedule: TaskSchedule; reason?: string; message?: string }>('operation.invoke', { name: 'schedule.update', input: { spaceId, scheduleId, status: 'paused' } });
  for (const trigger of [{ triggerType: 'at', runAt: Date.now() + 86400000 }, { triggerType: 'cron', cronExpression: '0 0 * * *' }]) {
    const original = (await rpc('taskSchedule.create', { ...trigger, spaceId: space.id, title: 'Deferred task', description: 'Preserve schedule 甲乙🙂'.repeat(3000), priority: 'high', labels: ['ordered', 'βeta'], timezone: 'UTC' })).schedule;
    assert(original.pendingJobId); assert.equal(app.jobQueue.getJob(original.pendingJobId)?.status, 'pending');
    measuring = true;
    const foreign = await pause(other.id, original.id); assert.equal(foreign.ok, false); assert.equal(foreign.reason, 'schedule_not_found');
    measuring = false;
    assert.equal(app.jobQueue.getJob(original.pendingJobId)?.status, 'pending');
    measuring = true;
    const result = await pause(space.id, original.id); assert.equal(result.ok, true); const paused = result.schedule;
    measuring = false;
    assert.equal(paused.status, 'paused'); assert.equal(paused.pendingJobId, null);
    assert.equal(app.jobQueue.getJob(original.pendingJobId), null);
    assert(paused.updatedAt >= original.updatedAt);
    assert.deepEqual({ ...paused, status: original.status, pendingJobId: original.pendingJobId, updatedAt: original.updatedAt }, original);
    const read = (await rpc('taskSchedule.get', { scheduleId: original.id, spaceId: space.id })).schedule;
    assert.deepEqual(read, paused);
    measuring = true;
    const repeated = await pause(space.id, original.id); assert.equal(repeated.ok, true); assert.deepEqual(repeated.schedule, paused);
    measuring = false;
    assert.deepEqual((await rpc('taskSchedule.get', { scheduleId: original.id, spaceId: space.id })).schedule, paused);
  }
  measuring = true;
  const missing = await pause(space.id, 'missing-schedule'); assert.equal(missing.ok, false); assert.equal(missing.reason, 'schedule_not_found');
  measuring = false;
  const rollback = (await rpc('taskSchedule.create', { spaceId: space.id, title: 'Rollback fixture', triggerType: 'at', runAt: Date.now() + 86400000 })).schedule;
  assert(rollback.pendingJobId);
  raw.exec(`CREATE TRIGGER verify_pause_failure BEFORE UPDATE ON task_schedules WHEN OLD.id = '${rollback.id}' AND NEW.status = 'paused' BEGIN SELECT RAISE(ABORT, 'synthetic pause failure'); END`);
  try {
    measuring = true;
    const rejected = await pause(space.id, rollback.id); assert.equal(rejected.ok, false); assert.equal(rejected.reason, 'rejected'); assert.match(rejected.message ?? '', /synthetic pause failure/);
  } finally { measuring = false; raw.exec('DROP TRIGGER verify_pause_failure'); }
  assert.deepEqual((await rpc('taskSchedule.get', { scheduleId: rollback.id, spaceId: space.id })).schedule, rollback);
  assert.equal(app.jobQueue.getJob(rollback.pendingJobId)?.status, 'pending', 'A failed pause must roll back its paired job deletion');
  assert.deepEqual(mainSql, [], 'Schedule operation pause and paired job deletion SQL must leave the main connection');
  console.log('ok: real schedule.update operation pauses at/cron schedules, preserves no-op/rejection semantics and rolls back failed pauses with zero target SQL on main');
} finally {
  measuring = false; ws?.close(); await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/schedule-operation-pause-writer.json'), JSON.stringify({ mode, mainSql, replies }, null, 2));
}
