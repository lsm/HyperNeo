import { saveWorkFeedChunk } from '../../../packages/daemon/src/storage/work-feed.ts';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { SettingsRepository } from '../../../packages/daemon/src/storage/repositories/settings-repository.ts';
const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const path of ['data', 'home/.codex', 'workspace', 'evidence', 'bin', 'home/.claude/projects/synthetic']) mkdirSync(join(run, path), { recursive: true });
const codex = new Database(join(run, 'home/.codex/state_5.sqlite'));
codex.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
CREATE TABLE projects (id TEXT, name TEXT, updated_at_ms INTEGER);
CREATE TABLE project_roots (project_id TEXT, path TEXT);`);
const ref = { adapter: 'codex-desktop', id: 'synthetic-worker' };
const rollout = join(run, 'worker.jsonl');
writeFileSync(rollout, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete' } }) + '\n');
codex.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ref.id, 'Claude something', '', '', join(run, 'workspace'), 'desktop', 0, Date.now(), rollout);
codex.close();
const db = new Database(join(run, 'data/daemon.db'));
try {
  runMigrations(db, () => {}); createTables(db); runMigrations(db, () => {});
  writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\n[ "$1" = agents ] && [ "$2" = --json ] || exit 2\nprintf "agents\\n" >> "$HOME/../evidence/claude-agents.log"\nprintf "[]\\n"\n', { mode: 0o700 });
  for (let i = 0; i < 10; i++) {
    const id = `synthetic-history-${i}`, text = `workerhistoryprobe plan ${i}`, at = Date.now();
    const path = join(run, `home/.claude/projects/synthetic/${id}.jsonl`);
    const content = JSON.stringify({ type: 'user', cwd: '/synthetic/history', uuid: `${id}-input`, timestamp: new Date(at).toISOString(), message: { content: text } }) + '\n';
    writeFileSync(path, content);
    saveWorkFeedChunk(db, 'claude', text, [{ sourceId: `${id}-input`, messageId: `${id}-input`, sessionId: id, role: 'user', text, at }], path, { size: Buffer.byteLength(content), offset: Buffer.byteLength(content), mtime: at });
  }
  const root = 'neo:10000000-0000-4000-8000-000000008120';
  db.prepare(`INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES (?,'Synthetic Neo',?,'2026-10-21T00:00:00Z','2026-10-21T00:00:00Z','active','{"queryMode":"manual"}','{}')`).run(root, run);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  new SettingsRepository(db).updateGlobalSettings({ language: 'en' });
  const store = new NeoAskTodoRepository(db);
  store.openAsk({ id: 'worker-card', title: 'Synthetic worker identity', sessionId: root, projectId: null, originMessageId: null, request: 'Synthetic identity proof only.', createdAt: Date.now() });
  store.addTodo('worker-todo', 'worker-card', { title: 'Verify current worker label', doneWhen: 'Current name with factual engine', check: null, instruction: null, named: null }, Date.now());
  const sessions = new NeoTodoSessionRepository(db);
  sessions.create('worker-todo', { verb: 'send', ref });
  sessions.recordRef('worker-todo', ref, Date.now(), 'codex://threads/synthetic-worker');
  const group = { id: 'worker-group', at: Date.now(), line: 'Historical name needs you', notices: [
    { key: 'worker-notice', ref, title: 'Creation-time name', kind: 'needs_you', at: Date.now() },
    { key: 'missing-notice', ref: { adapter: 'codex-desktop', id: 'missing-worker' }, title: 'Old deleted name', kind: 'needs_you', at: Date.now() },
  ] };
  new SDKMessageRepository(db).saveSDKMessage(root, { type: 'system', subtype: 'session_notices', uuid: group.id, session_id: root, content: group.line, group } as unknown as SDKMessage);
  writeFileSync(join(run, 'evidence/seed.json'), JSON.stringify({ root, ref, synthetic: true }, null, 2));
} finally { db.close(); }
