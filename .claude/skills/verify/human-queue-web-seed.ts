import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
const path = join(run, 'data/daemon.db');
assert(!existsSync(path), 'seed only a fresh synthetic database');
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const db = new Database(path);
try {
  runMigrations(db, () => {});
  createTables(db);
  runMigrations(db, () => {});
  const root = 'neo:10000000-0000-4000-8000-00000000a11e';
  db.prepare(`INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES (?,'Synthetic inbox proof',?,'2026-11-16T00:00:00Z','2026-11-16T00:00:00Z','active','{"queryMode":"manual"}','{}')`).run(root, run);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(db);
  const now = Date.now();
  const ask = (id: string, title: string) =>
    store.openAsk({ id, title, topic: null, sessionId: root, projectId: null, originMessageId: null, request: 'Synthetic inbox proof only.', createdAt: now });
  const todo = (id: string, askId: string, title: string, dependsOn: string[] = []) =>
    store.addTodo(id, askId, { approvedAt: now, title, doneWhen: 'Observed', check: null, instruction: 'Synthetic step', named: null, dependsOn }, now);
  const yesno = (id: string, askId: string, text: string, todoId: string | null) =>
    store.askQuestion(id, askId, { text, kind: 'yesno', options: null, multiple: false, noLabel: 'Not yet', yesLabel: 'Agree', ...(todoId ? { todoId } : {}) }, now);
  ask('release', 'Release the synthetic build');
  todo('ship', 'release', 'Ship the build');
  todo('notes', 'release', 'Write the release notes', ['ship']);
  yesno('ship-card', 'release', 'Ship the synthetic build to testers today?', 'ship');
  ask('rename', 'Rename the synthetic app');
  todo('name', 'rename', 'Pick a name');
  yesno('name-card', 'rename', 'Use "Quill" as the new name?', 'name');
  yesno('scope-card', 'rename', 'Rename the website too?', null);
  writeFileSync(join(run, 'evidence/seed.json'), JSON.stringify({ root, synthetic: true }, null, 2));
} finally {
  db.close();
}
console.log(`Seeded synthetic inbox: ${path}`);
