process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { gatewayFor } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { codingSessionAssignmentReads, codingSessionAssignmentWrites } from '../../../packages/daemon/src/lib/neo/packs/coding/session-assignments-worker.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const repo = 'synthetic/sessions';
const [first, second] = ['todo-first', 'todo-second'];
const session = { adapter: 'hyperneo', id: 'dev' };
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No HTTP in synthetic session assignment proof'); }) as typeof fetch;
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    try {
      await app.spaceRuntimeService.ready(); await app.jobProcessor.stop(); assert(![8399, 8499].includes(app.server.port));
      const db = app.db.getDatabase();
      const gateway = gatewayFor(db);
      const call = async (op: typeof codingSessionAssignmentReads | typeof codingSessionAssignmentWrites, method: string, input: unknown) => {
        const result = await gateway.run(op, { method, args: [input] });
        evidence.push({ phase, surface: 'daemon DB gateway', op: op.name, method, input, result });
        return result;
      };
      const lookup = (strategy: string, todoId: string) => call(codingSessionAssignmentReads, 'owner', { strategy, repo, featureKey: 'feature', todoId });
      if (phase === 'initial') {
        const todos = new NeoAskTodoRepository(db);
        todos.openAsk({ id: 'ask', projectId: null, sessionId: 'neo', originMessageId: null, title: 'Synthetic feature', request: 'Two slices', createdAt: 1 });
        for (const id of [first, second]) todos.addTodo(id, 'ask', { title: id, doneWhen: 'Merged', check: null, instruction: 'Synthetic', named: null }, 1);
        const reserve = (todoId: string) => call(codingSessionAssignmentWrites, 'reserveFeature', { repo, featureKey: 'feature', todoId, now: Date.now() });
        const owners = await Promise.all([reserve(first), reserve(second), reserve(first)]);
        assert.deepEqual(owners, Array(3).fill({ todoId: first, ref: null }));
        db.prepare('INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)').run(first, JSON.stringify({ verb: 'start' }), JSON.stringify(session));
      } else {
        assert.deepEqual(await lookup('long_lived', second), { todoId: first, ref: session });
        assert.equal(await lookup('per_task', second), null);
      }
    } finally { await app.cleanup(); }
  }
  console.log(`PASS: concurrent reservations agree on one feature owner, it survives a daemon restart and resolves to the owner's session; per-task work does not inherit it. Evidence: ${run}/evidence/session-assignments.json`);
} finally {
  writeFileSync(join(run, 'evidence/session-assignments.json'), JSON.stringify(evidence, null, 2));
  globalThis.fetch = network;
}
