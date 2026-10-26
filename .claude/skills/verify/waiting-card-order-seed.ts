import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { SettingsRepository } from '../../../packages/daemon/src/storage/repositories/settings-repository.ts';
const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
const path = join(run, 'data/daemon.db');
if (process.argv[3] === 'update') {
  assert(path.startsWith('/private/tmp/hyperneo-8909-'));
  const fixture = new Database(path);
  try {
    assert.equal(fixture.prepare("SELECT title FROM sessions WHERE id = 'neo:10000000-0000-4000-8000-000000008909'").get()?.title, 'Synthetic ordering proof');
    fixture.prepare("UPDATE neo_asks SET outcome = 'Unrelated status update', updated_at = ? WHERE id = 'waiting-old'").run(Date.now());
  } finally { fixture.close(); }
  process.exit(0);
}
assert(!existsSync(path), 'seed only a fresh synthetic database');
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const db = new Database(path);
try {
  runMigrations(db, () => {}); createTables(db); runMigrations(db, () => {});
  const root = 'neo:10000000-0000-4000-8000-000000008909';
  db.prepare(`INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES (?,'Synthetic ordering proof',?,'2026-10-25T00:00:00Z','2026-10-25T00:00:00Z','active','{"queryMode":"manual"}','{}')`).run(root, run);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  new SettingsRepository(db).updateGlobalSettings({ language: 'en' });
  const store = new NeoAskTodoRepository(db);
  const base = Date.parse('2026-10-25T00:00:00Z');
  for (const [id, title, time, state] of [
    ['waiting-old', 'Older human decision', 1, 'blocked'],
    ['waiting-b', 'New human decision B', 2, 'todo'],
    ['waiting-a', 'New human decision A', 2, 'todo'],
    ['blocked', 'Blocked work in progress', 3, 'blocked'],
    ['running', 'Running work', 4, 'doing'],
    ['queued', 'Queued work', 5, 'todo'],
    ['done', 'Finished work', 6, 'done'],
  ] as const) {
    const now = base + time * 1000;
    store.openAsk({ id, title, sessionId: root, projectId: null, originMessageId: null, request: 'Synthetic ordering verification.', createdAt: now });
    const todo = store.addTodo(`${id}-step`, id, { title: `${title} step`, doneWhen: 'Observed result', check: null, instruction: null, named: null }, now);
    store.updateTodo(todo, { state, ...(state === 'blocked' ? { blockedReason: 'Synthetic dependency' } : {}) }, now);
    if (id.startsWith('waiting-')) store.askQuestion(`${id}-question`, id, { kind: 'choice', text: `Choose for ${title}`, options: ['Continue', 'Revise'] }, now);
  }
} finally { db.close(); }
