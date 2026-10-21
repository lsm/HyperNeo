import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
mkdirSync(join(run, 'evidence'), { recursive: true });
const db = new Database(path);
try {
  runMigrations(db, () => {}); createTables(db); runMigrations(db, () => {});
  const root = 'neo:10000000-0000-4000-8000-000000008052';
  db.prepare(`INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES (?,'Synthetic collapse proof',?,'2026-10-21T00:00:00Z','2026-10-21T00:00:00Z','active','{"queryMode":"manual"}','{}')`).run(root, run);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  new SettingsRepository(db).updateGlobalSettings({ language: 'en' });
  const store = new NeoAskTodoRepository(db);
  for (const [id, title] of [['collapse-card', 'Synthetic long todo card'], ['other-card', 'Other synthetic card']]) {
    store.openAsk({ id, title, sessionId: root, projectId: null, originMessageId: null, request: 'Synthetic disclosure verification only.', createdAt: Date.now() });
    for (let i = 1; i <= (id === 'collapse-card' ? 3 : 1); i++) {
      const todo = store.addTodo(`${id}-${i}`, id, { title: `Synthetic step ${i}`, doneWhen: 'Observed result', check: null, instruction: null, named: null }, Date.now());
      store.updateTodo(todo, { state: 'blocked', blockedReason: `Waiting on synthetic input ${i}. ${'A long status line that used to fill this card. '.repeat(12)}`, nextAction: `Review the synthetic result ${i}.`, report: `Report ${i}: ${'Detailed synthetic work. '.repeat(15)}`, evidence: `Evidence ${i}: ${'Observed synthetic check. '.repeat(12)}` }, Date.now());
    }
  }
  writeFileSync(join(run, 'evidence/seed.json'), JSON.stringify({ root, cards: ['collapse-card', 'other-card'], synthetic: true }, null, 2));
} finally { db.close(); }
console.log(`Seeded synthetic disclosure cards: ${path}`);
