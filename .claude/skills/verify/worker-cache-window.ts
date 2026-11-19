import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NEO_DRIVER_REFRESH } from '../../../packages/daemon/src/lib/neo/driver-refresh.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { readWorkerLastTurn } from '../../../packages/daemon/src/storage/repositories/work-started-sessions-worker.ts';
import { JobQueueRepository } from '../../../packages/daemon/src/storage/repositories/job-queue-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import type { Result, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'project'), { recursive: true });
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'project') }), disableWorktrees: true }, verbose: false });
try {
  app.jobProcessor.stopPolling();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const store = new NeoAskTodoRepository(db);
  const bindings = new NeoTodoSessionRepository(db);
  const registry = app.sessionManager.getOperationRegistry();
  const caller = { source: 'internal' as const, role: 'neo' as const, sessionId: 'synthetic-neo' };
  db.prepare(`INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
    VALUES ('core', 'global', '', 'sessionReuse', '"per_ask"', 'human', 1)`).run();
  const workers: Record<string, { adapter: string; id: string }> = {};
  const folder = join(run, 'project');
  for (const name of ['cold', 'warm']) {
    store.openAsk({ id: `ask-${name}`, projectId: null, sessionId: caller.sessionId, originMessageId: null, title: name, request: 'Synthetic', createdAt: 1 });
    store.addTodo(name, `ask-${name}`, { title: name, doneWhen: 'Observed', check: null, instruction: 'Synthetic', named: null }, 1);
    const outcome = await invokeOperation(registry, 'work.start', { adapter: 'hyperneo', place: { machine: hostname(), folder, name }, title: name, message: 'Synthetic', todoId: name }, caller);
    assert.equal(outcome.kind, 'completed', JSON.stringify(outcome));
    const result = (outcome as { value: Result<WorkStarted> }).value;
    assert(result.ok, JSON.stringify(result));
    workers[name] = result.value.ref;
    bindings.create(name, { verb: 'start', adapter: 'hyperneo', place: { machine: hostname(), folder, name } });
    bindings.recordRef(name, result.value.ref, Date.now());
    for (let i = 0; i < 100; i++) {
      const status = await invokeOperation(registry, 'work.status', { ref: result.value.ref }, caller);
      if (status.kind === 'completed' && (status.value as { value?: { status: string } }).value?.status === 'done') break;
      await Bun.sleep(100);
    }
  }
  for (const name of ['cold', 'warm']) {
    const oneHour = 0;
    const uuid = crypto.randomUUID();
    app.db.saveSDKMessage(workers[name].id, {
      type: 'assistant',
      uuid,
      session_id: workers[name].id,
      parent_tool_use_id: null,
      message: { id: uuid, type: 'message', role: 'assistant', model: 'synthetic', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: oneHour, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: oneHour, ephemeral_5m_input_tokens: 0 } } },
    } as unknown as SDKMessage);
    store.updateTodo(store.getTodo(name)!, { state: 'done', finishedAt: Date.now() }, Date.now());
  }
  for (let i = 0; i < 100 && !Object.values(workers).every((ref) => readWorkerLastTurn(db, ref.id)); i++)
    await Bun.sleep(50);
  assert(Object.values(workers).every((ref) => readWorkerLastTurn(db, ref.id)), 'saved turns are not readable');
  const jobs = new JobQueueRepository(db);
  const facts = () => db.prepare(`SELECT todo_id AS todo, key FROM pack_facts
    WHERE pack = 'core' AND key IN ('released', 'release_kept') ORDER BY todo_id`).all() as { todo: string; key: string }[];
  for (let i = 0; i < 50 && facts().length < 2; i++) {
    db.prepare(`DELETE FROM job_queue WHERE queue = ? AND status = 'pending'`).run(NEO_DRIVER_REFRESH);
    for (const [name, minutes] of [['cold', 120], ['warm', 1]] as const)
      db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE session_id = ? AND message_type = 'assistant'`)
        .run(new Date(Date.now() - minutes * 60_000).toISOString(), workers[name].id);
    jobs.enqueue({ queue: NEO_DRIVER_REFRESH, payload: { scope: 'neo' }, runAt: 0 });
    await app.jobProcessor.tick();
    await Bun.sleep(100);
  }
  const status = (id: string) => (db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as { status: string }).status;
  const seen = facts();
  const turns = db.prepare(`SELECT session_id, message_type, timestamp, parent_tool_use_id FROM sdk_messages WHERE session_id IN (?, ?) ORDER BY timestamp`).all(workers.cold.id, workers.warm.id);
  const evidence = { turns, workers, facts: seen, cold: status(workers.cold.id), warm: status(workers.warm.id) };
  writeFileSync(join(run, 'evidence/worker-cache-window.json'), JSON.stringify(evidence, null, 2));
  assert.deepEqual(seen, [{ todo: 'cold', key: 'released' }, { todo: 'warm', key: 'release_kept' }], JSON.stringify(evidence));
  assert.equal(evidence.cold, 'archived', JSON.stringify(evidence));
  assert.notEqual(evidence.warm, 'archived', JSON.stringify(evidence));
  console.log('PASS: the cold-cache worker was archived and the warm-cache worker was kept for reuse; count=2');
} finally {
  await app.cleanup();
}
