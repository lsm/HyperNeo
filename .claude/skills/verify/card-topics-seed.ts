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
const cards = [
  ['screen-time', 'Synthetic screen time limits', '家长控制', 'doing'],
  ['app-approvals', 'Synthetic app approvals', '家长控制', 'todo'],
  ['protocol', 'Synthetic protocol draft', 'OAP', 'doing'],
  ['signing', 'Synthetic signing flow', 'Countersign', 'todo'],
  ['inbox', 'Synthetic inbox triage', '邮件', 'done'],
  ['misc', 'Synthetic loose ends', '其他', 'dropped'],
  ['plain', 'Synthetic card without a topic', null, 'todo'],
] as const;
try {
  runMigrations(db, () => {});
  createTables(db);
  runMigrations(db, () => {});
  const root = 'neo:10000000-0000-4000-8000-000000004c3f';
  db.prepare(`INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES (?,'Synthetic topic proof',?,'2026-11-07T00:00:00Z','2026-11-07T00:00:00Z','active','{"queryMode":"manual"}','{}')`).run(root, run);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  new SettingsRepository(db).updateGlobalSettings({ language: 'zh-Hans' });
  const store = new NeoAskTodoRepository(db);
  for (const [id, title, topic, state] of cards) {
    const ask = store.openAsk({ id, title, topic, sessionId: root, projectId: null, originMessageId: null, request: 'Synthetic topic proof only.', createdAt: Date.now() });
    const todo = store.addTodo(`${id}-1`, id, { title: 'Synthetic step', doneWhen: 'Observed', check: null, instruction: null, named: null }, Date.now());
    if (state === 'doing') store.updateTodo(todo, { state: 'doing' }, Date.now());
    if (state === 'done' || state === 'dropped') store.settleAsk(ask, state, 'Synthetic outcome', Date.now());
  }
  writeFileSync(join(run, 'evidence/seed.json'), JSON.stringify({ root, cards, synthetic: true }, null, 2));
} finally {
  db.close();
}
console.log(`Seeded synthetic topic cards: ${path}`);
