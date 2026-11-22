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
  const root = 'neo:10000000-0000-4000-8000-000000010781';
  db.prepare(`INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES (?,'Synthetic inbox proof',?,'2026-11-16T00:00:00Z','2026-11-16T00:00:00Z','active','{"queryMode":"manual"}','{}')`).run(root, run);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(db);
  const now = Date.now();
  const ask = (id: string, title: string, topic: string) =>
    store.openAsk({ id, title, topic, sessionId: root, projectId: null, originMessageId: null, request: 'Synthetic inbox proof only.', createdAt: now });
  const todo = (id: string, askId: string, title: string) =>
    store.addTodo(id, askId, { title, doneWhen: 'Observed', check: null, instruction: 'Synthetic', named: null, approvedAt: now }, now);
  const card = (id: string, askId: string, text: string, todoId?: string) =>
    store.askQuestion(id, askId, { text, kind: 'yesno', options: null, multiple: false, noLabel: 'Not now', yesLabel: 'Agree', ...(todoId ? { todoId } : {}) }, now);
  ask('trip', 'Synthetic trip plan', 'Travel');
  ask('tax', 'Synthetic tax filing', 'Finance');
  ask('car', 'Synthetic car service', 'Travel');
  ask('tickets', 'Synthetic railway tickets', 'Travel');
  ask('budget', 'Synthetic budget', 'Finance');
  card('tickets-card', 'tickets', 'Take the morning train?');
  card('budget-card', 'budget', 'Use the revised total?');
  card('trip-card', 'trip', 'Keep the trip to one week?');
  todo('hotel', 'trip', 'Book the hotel');
  todo('bags', 'trip', 'Pack the bags');
  todo('receipts', 'tax', 'Find the receipts');
  todo('garage', 'car', 'Call the garage');
  card('hotel-card', 'trip', 'Book the hotel by the station for three nights?', 'hotel');
  card('tax-card', 'tax', 'File jointly this year?', 'receipts');
  assert(store.holdQuestion('trip-card', true, crypto.randomUUID(), now), 'the seed holds one card');
  writeFileSync(join(run, 'evidence/seed.json'), JSON.stringify({ root, synthetic: true }, null, 2));
} finally {
  db.close();
}
console.log(`Seeded synthetic inbox: ${path}`);
