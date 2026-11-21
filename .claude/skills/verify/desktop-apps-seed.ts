import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { SettingsRepository } from '../../../packages/daemon/src/storage/repositories/settings-repository.ts';
import { proposalQuestionId } from '../../../packages/daemon/src/lib/neo/proposal.ts';
import { desktopAppsLine } from '../../../packages/daemon/src/lib/desktop/app-scope.ts';

const run = resolve(process.argv[2]);
const language = process.argv[3] === 'en' ? 'en' : 'zh-Hans';
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(resolve(process.env.HOME ?? ''), join(run, 'home'));
const path = join(run, 'data/daemon.db');
assert(!existsSync(path), 'seed only a fresh synthetic database');
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const db = new Database(path);
const chrome = { bundleId: 'com.google.Chrome', name: 'Google Chrome' };
try {
  runMigrations(db, () => {});
  createTables(db);
  runMigrations(db, () => {});
  const root = 'neo:10000000-0000-4000-8000-00000000d35c';
  db.prepare(`INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES (?,'Synthetic desktop apps',?,'2026-11-21T00:00:00Z','2026-11-21T00:00:00Z','active','{"queryMode":"manual"}','{}')`).run(root, run);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  new SettingsRepository(db).updateGlobalSettings({ language });
  const store = new NeoAskTodoRepository(db);
  const now = Date.now();
  const open = (id: string, title: string, request: string) =>
    store.openAsk({ id, title, topic: '其他', sessionId: root, projectId: null, originMessageId: null, request, createdAt: now });
  open('proposal', 'Synthetic invoice lookup', 'Synthetic: find the March invoice in the browser?');
  store.addAskDesktopApps('proposal', [chrome], now);
  store.askQuestion(proposalQuestionId('proposal'), 'proposal', { text: `Synthetic: find the March invoice in the browser?\n\n${desktopAppsLine([chrome])}`, kind: 'yesno', options: null, multiple: false, yesLabel: null, noLabel: null }, now);
  for (const [ask, title, apps] of [
    ['with-apps', 'Synthetic: use Chrome to check the order', [chrome]],
    ['no-apps', 'Synthetic: summarize the attached notes', null],
  ] as const) {
    open(ask, title, title);
    const todo = `${ask}-todo`;
    store.addTodo(todo, ask, { title: `${title} (step)`, doneWhen: 'Observed', check: null, instruction: null, named: null, ...(apps ? { desktopScope: [...apps] } : {}) }, 0);
    db.prepare("UPDATE neo_todos SET state = 'doing', approved_at = ?, started_at = ? WHERE id = ?").run(now, now, todo);
    db.prepare('INSERT INTO neo_todo_sessions(todo_id, target, ref) VALUES(?, ?, ?)').run(todo, '{}', JSON.stringify({ adapter: 'hyperneo', id: `worker-${ask}` }));
  }
  writeFileSync(join(run, 'evidence/seed.json'), JSON.stringify({ root, language, synthetic: true }, null, 2));
} finally {
  db.close();
}
console.log(`Seeded synthetic desktop app scope: ${path}`);
