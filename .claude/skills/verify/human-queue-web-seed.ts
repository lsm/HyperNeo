import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
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
  const projects = new NeoRepository(db);
  projects.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(db);
  const now = Date.now();
  const ask = (id: string, title: string, topic: string | null, projectId: string | null = null) =>
    store.openAsk({ id, title, topic, sessionId: root, projectId, originMessageId: null, request: 'Synthetic inbox proof only.', createdAt: now });
  const todo = (id: string, askId: string, title: string) =>
    store.addTodo(id, askId, { title, doneWhen: 'Observed', check: null, instruction: 'Synthetic', named: null, approvedAt: now }, now);
  const card = (id: string, askId: string, text: string, todoId?: string) =>
    store.askQuestion(id, askId, { text, kind: 'yesno', options: null, multiple: false, noLabel: 'Not now', yesLabel: 'Agree', ...(todoId ? { todoId } : {}) }, now);
  const phase = process.argv[3];
  if (phase === 'short-topics') {
    for (const [id, title] of [
      ['payments', 'Payments'],
      ['app', 'HyperNeo'],
      ['api', 'API'],
      ['generic', 'Weekend Plans'],
      ['long-a', '甲乙丙丁戊己庚'],
      ['long-b', '甲乙丙丁戊癸壬'],
    ]) assert(projects.saveProject({ id, title, summary: '', context: '' }, 0));
    const alias = db.prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)');
    alias.run('repository:github.com/example/hyperneo', 'app');
    alias.run(`work:${hostname()}\u0000claude-code\u0000sender`, 'payments');
    const longTitle = 'Synthetic session request '.repeat(5).slice(0, 120);
    const legacy = '甲乙丙丁戊己A';
    for (const [i, [id, project, pick]] of [
      ['legacy', null, legacy],
      ['generic', 'generic', null],
      ['long-b', 'long-b', null],
      ['long-a', 'long-a', null],
      ['api', 'api', null],
      ['app', 'app', null],
      ['pay-primary', 'payments', null],
      ['pay-sender', null, null],
    ].entries()) {
      ask(id!, id === 'pay-sender' || id === 'legacy' ? longTitle : `Synthetic ${id} question`, pick ?? null, project ?? null);
      store.askQuestion(`waiting-${id}`, id!, { text: `Waiting ${id}?`, kind: 'yesno', options: null, multiple: false, noLabel: 'Not now', yesLabel: 'Agree' }, now + i);
    }
    store.addTodo('request', 'pay-sender', { title: 'Reply to sender', doneWhen: 'Observed', check: null, instruction: null, named: { requestFrom: 'claude-code:sender' } }, now);
    store.addTodo('unlinked-request', 'legacy', { title: 'Reply to unlinked sender', doneWhen: 'Observed', check: null, instruction: null, named: { requestFrom: 'claude-code:unlinked' } }, now);
    for (const [i, id] of ['pay-sender', 'pay-primary', 'api', 'long-b', 'long-a'].entries()) {
      const questionId = `held-${id}`;
      store.askQuestion(questionId, id, { text: `Held ${id}?`, kind: 'yesno', options: null, multiple: false, noLabel: 'Not now', yesLabel: 'Agree' }, now + i);
      assert(store.holdQuestion(questionId, true, crypto.randomUUID(), now));
    }
  } else if (phase === 'phone-parity') {
    const old = now - 3 * 24 * 60 * 60 * 1000;
    const step = (id: string, askId: string, title: string, at = old) =>
      store.addTodo(id, askId, { title, doneWhen: 'Observed', check: null, instruction: 'Synthetic', named: null, approvedAt: at }, at);
    ask('research', 'Synthetic research database decision', 'Research');
    step('research-step', 'research', 'Pick a research database');
    ask('reminders', 'Synthetic future reminders', 'Home');
    step('reminder-19', 'reminders', 'Remind me on Dec 19');
    step('reminder-22', 'reminders', 'Remind me on Dec 22');
    ask('big', 'Synthetic long checklist', 'Home');
    const finish = db.prepare("UPDATE neo_todos SET state = 'done', started_at = ?, finished_at = ? WHERE id = ?");
    for (let i = 0; i < 28; i++) {
      step(`big-${i}`, 'big', `Checklist step ${i + 1}`, now);
      if (i >= 2) finish.run(now, now, `big-${i}`);
    }
    for (let i = 0; i < 12; i++) {
      ask(`filed-${i}`, `Synthetic filed outcome ${i + 1}`, 'Archive');
      store.settleAsk(store.getAsk(`filed-${i}`)!, 'done', 'Filed', now - (i + 1) * 1000);
    }
  } else {
    ask('trip', 'Synthetic trip plan', 'Travel');
    ask('tax', 'Synthetic tax filing', 'Finance');
    ask('car', 'Synthetic car service', 'Finance');
    ask('tickets', 'Synthetic railway tickets', phase === 'after' ? 'Rail Tickets' : 'Travel');
    ask('budget', 'Synthetic budget', phase === 'after' ? 'Budget Plans' : 'Finance');
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
    if (phase === 'waiting-only') {
      ask('archive', 'Synthetic filed archive', 'Finance');
      store.settleAsk(store.getAsk('archive')!, 'done', 'Filed', now);
    }
    if (phase === 'late-reference') {
      const conversationId = projects.conversationId();
      assert(conversationId);
      const publicationId = crypto.randomUUID();
      const payload = {
        conversationId, publicationId, shortText: 'I replied · View card · Held trip question',
        fullText: 'Synthetic reference', links: [],
        cardReply: { askId: 'trip', questionId: 'trip-card', mutationId: crypto.randomUUID(), sourceMessageIds: [crypto.randomUUID()] },
      };
      db.prepare('INSERT INTO neo_publications (conversation_id, publication_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(conversationId, publicationId, JSON.stringify(payload), new Date().toISOString());
    }
  }
  writeFileSync(join(run, 'evidence/seed.json'), JSON.stringify({ root, synthetic: true }, null, 2));
} finally {
  db.close();
}
console.log(`Seeded synthetic inbox: ${path}`);
