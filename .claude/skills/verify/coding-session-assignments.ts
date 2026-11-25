process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { gatewayFor } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { codingSessionAssignmentReads } from '../../../packages/daemon/src/lib/neo/packs/coding/session-assignments-worker.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  const db = app.db.getDatabase();
  const todos = new NeoAskTodoRepository(db);
  todos.openAsk({ id: 'ask', projectId: null, sessionId: 'neo', originMessageId: null, title: 'Synthetic', request: 'Synthetic', createdAt: 1 });
  todos.addTodo('todo', 'ask', { title: 'Slice', doneWhen: 'Done', check: null, instruction: 'Synthetic', named: null }, 1, 'github.com/synthetic/repo');
  const ref = { adapter: 'hyperneo', id: 'reviewer' };
  db.prepare("INSERT INTO pack_facts (todo_id, pack, key, value_json) VALUES (?, 'coding', ?, ?)").run('todo', 'assignment:synthetic:review', JSON.stringify({ ref }));
  const gateway = gatewayFor(db);
  const repo = await gateway.call(codingSessionAssignmentReads, 'repo', 'todo');
  const excluded = await gateway.call(codingSessionAssignmentReads, 'actorRefs', { adapter: 'hyperneo' });
  assert.equal(repo, 'github.com/synthetic/repo');
  assert.deepEqual(excluded, [ref]);
  evidence.push({ repo, excluded });
  console.log('PASS: the daemon gateway reads the todo repository and excludes its recorded review actor.');
} finally {
  writeFileSync(join(run, 'evidence/session-assignments.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
