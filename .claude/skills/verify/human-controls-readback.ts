import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
const db = new Database(join(run, 'data/daemon.db'), { readonly: true });
try {
  const todos = db
    .prepare("SELECT id, state, priority FROM neo_todos WHERE ask_id = 'controls' ORDER BY id")
    .all() as { id: string; state: string; priority: string }[];
  const cards = db
    .prepare(
      "SELECT cause, state, answer, todos, document, actions_applied_at AS actionsAppliedAt FROM neo_questions WHERE ask_id = 'controls' ORDER BY created_at"
    )
    .all();
  const settings = db.prepare("SELECT settings FROM global_settings LIMIT 1").get() as { settings: string };
  writeFileSync(join(run, 'evidence/readback.json'), JSON.stringify({ todos, cards, settings }, null, 2));
  const state = Object.fromEntries(todos.map((todo) => [todo.id, todo]));
  assert.equal(state['controls-done'].state, 'done');
  assert.equal(state['controls-cancel'].state, 'removed');
  assert.equal(state['controls-priority'].priority, 'urgent');
  assert.equal(state['controls-pause'].state, 'doing');
  assert.equal(state['controls-hold'].state, 'todo');
  const neo = JSON.parse(settings.settings).neo;
  assert.equal(neo.maxRunningTodos, 4);
  assert.equal(neo.maxRunningTodosPerProject, 2);
  const by = (cause: string) => (cards as { cause: string; state: string }[]).filter((card) => card.cause === cause);
  assert.deepEqual(by('hold').map((card) => card.state), ['answered']);
  assert.deepEqual(by('pause').map((card) => card.state), ['open']);
  console.log(JSON.stringify({ todos, cards }, null, 2));
  console.log('human-controls readback: PASS');
} finally {
  db.close();
}
