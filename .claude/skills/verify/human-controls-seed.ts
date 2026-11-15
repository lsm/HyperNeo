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
assert(!existsSync(path), 'seed only a fresh synthetic database');
mkdirSync(join(run, 'data'), { recursive: true });
const db = new Database(path);
try {
  runMigrations(db, () => {});
  createTables(db);
  runMigrations(db, () => {});
  const root = 'neo:10000000-0000-4000-8000-000000010486';
  db.prepare(
    `INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES (?,'Synthetic human controls',?,'2026-11-13T00:00:00Z','2026-11-13T00:00:00Z','active','{"queryMode":"manual"}','{}')`
  ).run(root, run);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  new SettingsRepository(db).updateGlobalSettings({ language: 'en' });
  const store = new NeoAskTodoRepository(db);
  const now = Date.now();
  store.openAsk({
    id: 'controls',
    title: 'Ship the synthetic release',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    request: 'Synthetic human-controls verification only.',
    createdAt: now,
  });
  const steps = [
    ['controls-hold', 'Write the release notes', 'high'],
    ['controls-pause', 'Run the data migration', 'normal'],
    ['controls-done', 'Update the changelog', 'normal'],
    ['controls-cancel', 'Draft the blog post', 'normal'],
    ['controls-priority', 'Tag the release', 'low'],
  ] as const;
  for (const [id, title, priority] of steps) {
    const todo = store.addTodo(
      id,
      'controls',
      { title, doneWhen: 'Observed result', check: null, instruction: null, named: null, approvedAt: now },
      now
    );
    store.updateTodo(
      todo,
      id === 'controls-pause' ? { priority, state: 'doing', startedAt: now } : { priority },
      now
    );
  }
} finally {
  db.close();
}
console.log(`Seeded synthetic human-controls ask: ${path}`);
