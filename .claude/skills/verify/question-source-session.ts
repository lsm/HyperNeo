import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { SettingsRepository } from '../../../packages/daemon/src/storage/repositories/settings-repository.ts';

const [directory, phase, port = '9482'] = process.argv.slice(2);
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.notEqual(port, '8399');
const root = 'neo:10000000-0000-4000-8000-000000008408';
const ref = { adapter: 'hyperneo', id: 'source-worker' };
const evidencePath = join(run, 'evidence/source-session.json');
if (phase === 'seed') {
  assert(!existsSync(join(run, 'data/daemon.db')));
  for (const part of ['data', 'workspace', 'evidence', 'bin']) mkdirSync(join(run, part), { recursive: true });
  writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
  const db = new Database(join(run, 'data/daemon.db'));
  try {
    runMigrations(db, () => {});
    createTables(db);
    runMigrations(db, () => {});
    for (const [id, title, provider] of [[root, 'Synthetic Neo', 'anthropic'], [ref.id, 'Review worker', 'glm']])
      db.prepare(`INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,'2026-10-23T00:00:00Z','2026-10-23T00:00:00Z','active',?,'{}')`)
        .run(id, title, join(run, 'workspace'), JSON.stringify({ provider, queryMode: 'manual' }));
    new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
    new NeoAskTodoRepository(db).openAsk({ id: 'source-ask', sessionId: root, projectId: null, originMessageId: null, title: 'Review a worker decision', request: 'Synthetic question source verification', createdAt: Date.now() });
    const legacy = new NeoAskTodoRepository(db);
    for (const [id, title] of [['ordinary-ask', 'Ask a general question'], ['start-ask', 'Start old work']])
      legacy.openAsk({ id, sessionId: root, projectId: null, originMessageId: null, title, request: 'Synthetic question source verification', createdAt: Date.now() });
    const held = legacy.addTodo('legacy-review', 'start-ask', { title: 'First review task', doneWhen: 'Synthetic work complete', check: null, instruction: 'Synthetic work; do not start', named: null }, Date.now());
    legacy.updateTodo(held, { state: 'blocked', blockedBy: 'question' }, Date.now());
    legacy.askQuestion('legacy-start', 'start-ask', { text: 'Start "First review task"?', kind: 'start', options: null, multiple: false, noLabel: null, yesLabel: null, startTodos: [held.id] }, Date.now());
    new NeoAskTodoRepository(db).askQuestion('linkless-source', 'source-ask', { text: 'Terminal worker recommendation', kind: 'reply', options: null, multiple: false, noLabel: null, yesLabel: null, startTodos: null, sourceSession: { adapter: 'claude-code', id: 'linkless-worker', name: 'Terminal worker', label: 'Claude Code · Terminal worker', provider: 'Claude', link: null } }, Date.now());
    new SettingsRepository(db).updateGlobalSettings({ language: 'en' });
  } finally { db.close(); }
} else {
  assert(['capture', 'restart'].includes(phase));
  const log = readFileSync(join(run, 'daemon.log'), 'utf8');
  assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/data/daemon.db`));
  const rpc = async (name: string, input: unknown) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
    const reply = JSON.parse(await new Response(child.stdout).text());
    assert.equal(await child.exited, 0);
    assert(!reply.reply.error, JSON.stringify(reply));
    return reply.reply.value ?? reply.reply;
  };
  const openUntilAnswered = { pack: 'core', kind: 'evidence', params: { path: join(run, 'never-written') } };
  const saved = phase === 'restart' ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null;
  const source = saved?.source ?? await rpc('neo.question.ask', { askId: 'source-ask', retireWhen: openUntilAnswered, kind: 'choice', text: 'Approve the worker recommendation?', options: ['Approve'], sourceSession: ref });
  assert(source.ok, JSON.stringify(source));
  const expected = { ...ref, name: 'Review worker', label: 'HyperNeo · Review worker', provider: 'glm', link: '/session/source-worker' };
  assert.deepEqual(source.question.sourceSession, expected);
  const ordinary = saved?.ordinary ?? await rpc('neo.question.ask', { askId: 'ordinary-ask', retireWhen: openUntilAnswered, kind: 'reply', text: 'Which repository should hold the general follow-up?' });
  assert(ordinary.ok, JSON.stringify(ordinary));
  assert(!ordinary.question.sourceSession);
  const start = saved?.start ?? await rpc('neo.question.ask', { askId: 'start-ask', retireWhen: openUntilAnswered, kind: 'start', text: 'Start after the worker review?', sourceSession: ref });
  assert(start.ok, JSON.stringify(start));
  assert.deepEqual(start.question.startTodos, ['legacy-review']);
  const joined = await rpc('neo.question.get', { questionId: start.question.id });
  assert.equal(joined.question.state, 'open');
  assert.deepEqual(joined.question.sourceSession, expected);
  const linkless = await rpc('neo.question.get', { questionId: 'linkless-source' });
  assert.equal(linkless.question.sourceSession.name, 'Terminal worker');
  assert.equal(linkless.question.sourceSession.link, null);
  const got = await rpc('neo.question.get', { questionId: source.question.id });
  assert.deepEqual(got.question.sourceSession, expected);
  const snapshot = await rpc('neo.snapshot', {});
  const entry = snapshot.todoAsks.find((entry: { ask: { id: string } }) => entry.ask.id === 'source-ask');
  assert.deepEqual(entry.questions.find((q: { id: string }) => q.id === source.question.id).sourceSession, expected);
  const ordinaryEntry = snapshot.todoAsks.find((entry: { ask: { id: string } }) => entry.ask.id === 'ordinary-ask');
  assert(!ordinaryEntry.questions.find((q: { id: string }) => q.id === ordinary.question.id).sourceSession);
  const refused = await rpc('neo.question.ask', { askId: 'source-ask', retireWhen: openUntilAnswered, kind: 'reply', text: 'Unavailable source', sourceSession: { ...ref, id: 'does-not-exist' }, replaces: source.question.id });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /source_session_unavailable/);
  if (phase === 'capture') assert.equal(got.question.state, 'open');
  else { assert.equal(got.question.state, 'answered'); assert.deepEqual(got.question.answer, ['Approve']); }
  writeFileSync(phase === 'capture' ? evidencePath : join(run, 'evidence/source-session-restart.json'), JSON.stringify({ source, ordinary, start, joined, linkless, got, entry, refused }, null, 2));
  console.log(`PASS: ${phase} source-session identity/ref survives the operation and snapshot payloads`);
}
