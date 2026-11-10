import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { neoFolder } from '../../../packages/daemon/src/lib/neo/folder.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { WorkTurnRepository } from '../../../packages/daemon/src/storage/repositories/work-turn-repository.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
const codexHome = join(run, 'home/.codex');
for (const dir of [codexHome, join(run, 'data'), join(run, 'project'), join(run, 'evidence')])
  mkdirSync(dir, { recursive: true });

const base = Date.now() - 600_000;
const stamp = (second: number) => new Date(base + second * 1000).toISOString();
const line = (second: number, type: string, payload: object) =>
  `${JSON.stringify({ timestamp: stamp(second), type, payload })}\n`;
const started = (second: number, turn: string) =>
  line(second, 'event_msg', { type: 'task_started', turn_id: turn });
const completed = (second: number, turn: string, text: string) =>
  line(second, 'event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: text });
const said = (second: number, id: string, text: string) =>
  line(second, 'response_item', {
    type: 'message',
    id,
    role: 'user',
    content: [{ type: 'input_text', text }],
  });
const ran = (second: number, output: string) =>
  line(second, 'response_item', { type: 'function_call_output', call_id: 'c', output });

const rollout = join(run, 'data/rollout.jsonl');
writeFileSync(
  rollout,
  [
    started(1, 'big-turn'),
    said(2, 'input-big', 'Open a PR'),
    ran(3, 'https://github.com/o/r/pull/1'),
    ran(4, 'x'.repeat(6 * 1024 * 1024)),
    completed(5, 'big-turn', 'Opened https://github.com/o/r/pull/1'),
    started(6, 'mention-turn'),
    said(7, 'input-mention', 'Look at https://github.com/o/r/pull/9'),
    completed(8, 'mention-turn', 'Nothing to change.'),
    started(9, 'aborted-turn'),
    said(10, 'input-aborted', 'Try again'),
    ran(11, 'https://github.com/o/r/pull/2'),
    line(12, 'event_msg', { type: 'turn_aborted', turn_id: 'aborted-turn', reason: 'interrupted' }),
    started(13, 'no-input-turn'),
    said(14, 'env', '<environment_context>x</environment_context>'),
    completed(15, 'no-input-turn', 'Continued.'),
    started(16, 'shared-turn'),
    said(17, 'input-a', 'First'),
    said(18, 'input-b', 'Steered in'),
    completed(19, 'shared-turn', 'Both done.'),
    started(20, 'unreadable-turn'),
    '{broken\n',
    completed(21, 'unreadable-turn', 'Done.'),
    started(22, 'running-turn'),
    ran(23, 'https://example.com/not-finished'),
  ].join('')
);
const codex = new Database(join(codexHome, 'state_5.sqlite'));
codex.exec(
  'CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT,updated_at_ms INTEGER); CREATE TABLE project_roots (project_id TEXT,position INTEGER,path TEXT); CREATE TABLE threads (id TEXT PRIMARY KEY,name TEXT,title TEXT,first_user_message TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at_ms INTEGER,rollout_path TEXT,git_branch TEXT)'
);
codex.prepare("INSERT INTO projects VALUES ('p','synthetic',1)").run();
codex.prepare("INSERT INTO project_roots VALUES ('p',0,?)").run(join(run, 'project'));
codex
  .prepare("INSERT INTO threads VALUES ('synthetic','synthetic','','',?,'vscode',0,?,?,NULL)")
  .run(join(run, 'project'), Date.now(), rollout);

const root = 'neo:10000000-0000-4000-8000-000000009880';
const ref = { adapter: 'codex-desktop', id: 'synthetic' };
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
const evidence: Record<string, unknown> = { daemonPort: app.server.port };
const refresh = async () => {
  const job = app.jobQueue.enqueue({
    queue: 'neo.work.driver.refresh',
    payload: { scope: 'neo' },
    runAt: Date.now(),
  });
  const deadline = performance.now() + 25000;
  while (performance.now() < deadline) {
    const current = app.jobQueue.getJob(job.id)!;
    if (current.status === 'completed') return;
    assert.notEqual(current.status, 'dead', JSON.stringify(current));
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('driver refresh did not complete');
};
try {
  const db = app.db.getDatabase();
  const now = new Date().toISOString();
  await app.db.createSession({
    id: root,
    title: 'Synthetic Neo',
    workspacePath: neoFolder(),
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  });
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const turns = new WorkTurnRepository(db);
  const touch = () =>
    codex.prepare("UPDATE threads SET updated_at_ms = ? WHERE id = 'synthetic'").run(Date.now());

  await refresh();
  assert.deepEqual(turns.list(ref), [], 'a running worker is not read');

  appendFileSync(rollout, completed(24, 'running-turn', 'Finished.'));
  touch();
  await refresh();
  const recorded = turns.list(ref);
  evidence.recorded = recorded;
  assert.deepEqual(
    recorded.map((turn) => [turn.id, turn.ended, turn.inputs, turn.urls, turn.complete]),
    [
      ['big-turn', 'completed', ['input-big'], ['https://github.com/o/r/pull/1'], true],
      ['mention-turn', 'completed', ['input-mention'], [], true],
      ['aborted-turn', 'aborted', ['input-aborted'], ['https://github.com/o/r/pull/2'], true],
      ['no-input-turn', 'completed', [], [], true],
      ['shared-turn', 'completed', ['input-a', 'input-b'], [], true],
      ['unreadable-turn', 'completed', [], [], false],
      ['running-turn', 'completed', [], ['https://example.com/not-finished'], true],
    ]
  );

  appendFileSync(
    rollout,
    started(25, 'next-turn') + completed(26, 'next-turn', 'https://github.com/o/r/pull/3')
  );
  touch();
  await refresh();
  const next = turns.list(ref);
  assert.equal(next.length, 8, 'the next read continues from where the last one stopped');
  assert.deepEqual(next[7].urls, ['https://github.com/o/r/pull/3']);
  evidence.afterAppend = next[7];
  evidence.verified = true;
  console.log('VERIFIED: Codex turns are recorded by turn ID; a read continues from its cursor');
} finally {
  codex.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
