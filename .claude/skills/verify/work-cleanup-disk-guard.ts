process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { statfsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const GiB = 1024 ** 3;
const run = resolve(process.argv.at(-1)!);
const expected = process.argv.at(-2);
assert(expected === 'floor' || expected === 'warn', 'pass floor or warn before the run directory');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'data'), { recursive: true });
const volume = statfsSync(join(run, 'data'));
const free = volume.bavail * volume.bsize;
assert(expected === 'floor' ? free < 10 * GiB : free >= 10 * GiB && free < 50 * GiB,
  `the data volume has ${(free / GiB).toFixed(1)} GiB free, which does not match ${expected}`);
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0,
  dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'home') }), disableGoalProcessing: true }, verbose: false });
const evidence: Record<string, unknown> = { expected, freeGiB: Number((free / GiB).toFixed(2)) };
try {
  await app.spaceRuntimeService.ready();
  assert.notEqual(app.server.port, 8399);
  const raw = app.db.getDatabase();
  const iso = new Date().toISOString();
  const root = `neo:${crypto.randomUUID()}`;
  raw.prepare('INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(root, 'Synthetic Neo', 'general', join(run, 'home'), iso, iso, 'active', '{}', '{}');
  new NeoRepository(raw).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const todos = new NeoAskTodoRepository(raw);
  todos.openAsk({ id: 'disk-ask', sessionId: root, projectId: null, originMessageId: null,
    title: 'Disk proof', request: 'Start a worker', createdAt: Date.now() });
  const queued = todos.addTodo('queued-todo', 'disk-ask',
    { title: 'Queued start', doneWhen: 'Done', instruction: 'Say hello.', named: null, check: null }, Date.now());
  new NeoTodoSessionRepository(raw).create(queued.id, { verb: 'start', adapter: 'hyperneo' });
  raw.prepare('UPDATE neo_todos SET approved_at = ? WHERE id = ?').run(Date.now(), queued.id);
  const job = (queue: string) => raw.prepare('SELECT id, status FROM job_queue WHERE queue = ? ORDER BY created_at DESC LIMIT 1').get(queue) as { id: string; status: string } | null;
  const sweepOnce = async () => {
    raw.prepare("UPDATE job_queue SET run_at = ? WHERE queue = 'neo.pack.sweep' AND status = 'pending'").run(Date.now());
    const id = job('neo.pack.sweep')?.id;
    for (let tries = 0; tries < 600; tries++) {
      const row = raw.prepare('SELECT status FROM job_queue WHERE id = ?').get(id) as { status: string } | null;
      if (row?.status === 'completed' || row?.status === 'failed') return row.status;
      await Bun.sleep(100);
    }
    throw new Error('the pack sweep did not run');
  };
  evidence.firstSweep = await sweepOnce();
  evidence.secondSweep = await sweepOnce();
  const told = raw.prepare("SELECT queue, payload FROM job_queue WHERE payload LIKE '%GiB free%'").all() as { queue: string; payload: string }[];
  evidence.told = told.map(({ queue, payload }) => ({ queue, text: JSON.parse(payload).message?.message?.content ?? JSON.parse(payload).text }));
  evidence.rows = raw.prepare("SELECT key FROM work_cleanup_gone WHERE key LIKE 'disk:%' ORDER BY key").all();
  evidence.backstops = raw.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE queue = 'work.cleanup.sweep' AND json_extract(payload, '$.reason') = 'disk'").get();
  const todo = todos.getTodo(queued.id)!;
  evidence.queuedTodo = { state: todo.state, startedAt: todo.startedAt, reason: todo.reason, blockedReason: todo.blockedReason };
  if (expected === 'floor') {
    assert(told.some(({ payload }) => payload.includes('under 10 GiB free')), 'Neo is told the volume is below the floor');
    assert.deepEqual(evidence.rows, [{ key: 'disk:floor' }, { key: 'disk:warn' }]);
    assert.deepEqual(evidence.backstops, { n: 1 }, 'the backstop runs once across two sweeps');
    assert.equal(todo.startedAt, null, 'a new worker start waits while the floor holds');
    assert.equal(todo.state, 'todo');
  } else {
    assert(told.some(({ payload }) => payload.includes('under 50 GiB free')), 'Neo is told the volume is below the warning level');
    assert(!told.some(({ payload }) => payload.includes('under 10 GiB free')), 'no floor notice');
    assert.deepEqual(evidence.rows, [{ key: 'disk:warn' }]);
    assert.deepEqual(evidence.backstops, { n: 0 });
    assert(todo.startedAt !== null || todo.state !== 'todo', 'without the floor the queued start is attempted');
  }
  console.log(`PASS: ${expected}: ${(free / GiB).toFixed(1)} GiB free; ${told.length} notice entries; backstops ${JSON.stringify(evidence.backstops)}; queued todo ${JSON.stringify(evidence.queuedTodo)}.`);
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/work-cleanup-disk-guard.json'), JSON.stringify(evidence, null, 2));
}
