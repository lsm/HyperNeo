import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { claudeDesktopWorkStatus, type ClaudeDesktopRecord } from '../../../packages/daemon/src/lib/drivers/claude-desktop-adapter.ts';
import type { WorkRef } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { createNeoTodoRunner } from '../../../packages/daemon/src/lib/neo/todo-runner.ts';
import { decideCodingSessionTarget } from '../../../packages/daemon/src/lib/neo/packs/coding/session-target.ts';
import { gatewayFor } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { recordedWorkInvoke } from '../../../packages/daemon/tests/unit/helpers/recorded-work-invoke.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  verbose: false,
});
const observed: unknown[] = [];
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const gateway = gatewayFor(db);
  const adapter = 'claude-desktop';
  const place = { machine: 'fixture', folder: join(run, 'workspace'), name: 'Fixture' };
  const ref = (id: string) => ({ adapter, id });
  const records = new Map<string, ClaudeDesktopRecord>();
  const calls: { operation: string; worker: string }[] = [];
  const runner = createNeoTodoRunner({
    store, sessions,
    packs: () => [{
      id: 'coding',
      describe: 'Synthetic coding dispatch',
      instructions: () => null,
      workerTarget: (todo, target, status) => decideCodingSessionTarget(db, todo, target, status),
    }],
    limits: () => ({ running: 99, perGroup: 99 }),
    write: gateway.run.bind(gateway),
    tell: async () => {},
    attend: async () => {},
    changed: () => {},
    invoke: recordedWorkInvoke(sessions.inputs, async (_caller, operation, input) => {
      const worker = operation === 'work.start' ? ref('fresh') : input.ref as WorkRef;
      const summary = { ref: worker, title: worker.id, place, lastActivityAt: 1 };
      if (operation === 'work.status') {
        const record = records.get(worker.id);
        assert(record, JSON.stringify(worker));
        return { kind: 'completed', value: { ok: true, value: {
          ...summary, status: claudeDesktopWorkStatus(record, new Map()),
        } } };
      }
      assert(['work.start', 'work.send'].includes(operation), operation);
      calls.push({ operation, worker: worker.id });
      const receipt = { executionId: worker.id, inputId: crypto.randomUUID() };
      return { kind: 'completed', value: { ok: true, value: { ...summary, delivered: true, receipt } } };
    }),
  });
  function seed(id: string, askId: string, repo: string, archive?: boolean) {
    if (!store.getAsk(askId))
      store.openAsk({ id: askId, sessionId: 'synthetic-neo', projectId: null, originMessageId: null, title: askId, request: askId, createdAt: 1 });
    const todo = store.addTodo(id, askId, {
      title: id, doneWhen: 'Observed', instruction: 'Run synthetic work', named: null,
      check: { pack: 'coding', kind: 'pr_merged', params: {} }, approvedAt: 1, dependsOn: [],
    }, 1);
    const name = archive === false ? 'frontend' : 'backend';
    sessions.create(id, { verb: 'start', adapter, place, name });
    db.prepare('INSERT INTO pack_coding_todos (todo_id, repo) VALUES (?, ?) ON CONFLICT(todo_id) DO UPDATE SET repo=excluded.repo').run(id, repo);
    if (archive !== undefined) {
      records.set(id, { sessionId: id, title: id, lastActivityAt: 1, cwd: place.folder, isArchived: archive });
      sessions.recordRef(id, ref(id), 1);
      store.updateTodo(todo, { state: 'done', startedAt: 1, finishedAt: 2 }, 2);
    }
  }
  for (const hasLive of [true, false]) {
    const variant = hasLive ? 'mixed' : 'archived-only';
    const repo = `synthetic/${variant}`;
    seed(`archived-${variant}`, `history-${variant}`, repo, true);
    if (hasLive) seed('idle', `history-${variant}`, repo, false);
    seed(variant, variant, repo);
    const result = await runner.start(variant);
    const binding = sessions.readRef(variant);
    observed.push({ variant, result, binding, calls: calls.slice(-1) });
    assert.equal(binding?.id, hasLive ? 'idle' : 'fresh');
    assert.equal(store.getTodo(variant)?.state, 'doing');
  }
  assert.deepEqual(calls, [
    { operation: 'work.send', worker: 'idle' },
    { operation: 'work.start', worker: 'fresh' },
  ]);
  process.stdout.write('PASS mixed=idle archived_only=fresh archived_sends=0\n');
} finally {
  writeFileSync(join(run, 'evidence/archived-worker-reuse.json'), JSON.stringify(observed, null, 2));
  await app.cleanup();
}
