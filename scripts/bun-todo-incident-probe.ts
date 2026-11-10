import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseCore } from '../packages/daemon/src/storage/database-core.ts';
import { DbGateway } from '../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { neoTodoSessionWrites } from '../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { waitForSdkBodyCopy } from '../.claude/skills/verify/wait-for-sdk-body-copy.ts';

const run = resolve(process.argv[2] ?? '');
assert(process.versions.bun, 'Use Bun for this probe');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')), 'Probe requires fresh owned data');
for (const key of [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
])
  assert.equal(process.env[key], undefined);
for (const folder of ['home', 'data', 'evidence'])
  mkdirSync(join(run, folder), { recursive: true });

const path = join(run, 'data/daemon.db');
const core = new DatabaseCore(path);
let initialized = false;
let gateway: DbGateway | undefined;
const evidence = {
  runtime: 'bun',
  startupBodyCopyComplete: false,
  progressCommit: false,
  progressRollback: false,
  singleIncident: false,
  incidentRollback: false,
  closedIncidentRefused: false,
  gatewayClosed: false,
  databaseClosed: false,
  pass: false,
};
try {
  await core.initialize();
  initialized = true;
  core.startSdkMessageBodyCopy();
  const db = core.getDb();
  await waitForSdkBodyCopy(db);
  evidence.startupBodyCopyComplete = true;
  gateway = new DbGateway(path, null);
  const askId = 'bun-progress-ask',
    todoId = 'bun-progress-todo';
  db.prepare(
    'INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES(?,?,?,?,1,1)'
  ).run(askId, 'bun-root', 'Synthetic progress', 'Observe');
  db.prepare(
    'INSERT INTO neo_todos(id,ask_id,position,title,done_when,created_at,updated_at) VALUES(?,?,0,?,?,1,1)'
  ).run(todoId, askId, 'Synthetic step', 'Observed');
  db.prepare(
    'INSERT INTO neo_todo_sessions(todo_id,target,live_status,needs_you_since,started_at) VALUES(?,?,?,?,?)'
  ).run(todoId, '{}', 'needs_you', 900, 1);
  const progress = {
    landed: 42,
    live: { status: 'running', lastActivityAt: 42 },
    cardStatus: 'running',
  } as const;
  const readIncident = () =>
    db
      .prepare(
        'SELECT started_at AS startedAt,checked_at AS checkedAt,live_status AS live,needs_you_since AS needs,unchecked FROM neo_todo_sessions WHERE todo_id=?'
      )
      .get(todoId);
  assert(await gateway.call(neoTodoSessionWrites, 'recordProgress', todoId, progress, 43));
  assert.deepEqual(readIncident(), {
    startedAt: 42,
    checkedAt: 43,
    live: 'running',
    needs: null,
    unchecked: 0,
  });
  evidence.progressCommit = true;
  db.prepare(
    'UPDATE neo_todo_sessions SET started_at=?,live_status=?,needs_you_since=? WHERE todo_id=?'
  ).run(1, 'needs_you', 900, todoId);
  const beforeRefusal = readIncident();
  db.exec(
    "CREATE TRIGGER reject_progress_check BEFORE UPDATE OF checked_at ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'synthetic progress refusal'); END"
  );
  try {
    await assert.rejects(
      gateway.call(
        neoTodoSessionWrites,
        'recordProgress',
        todoId,
        { ...progress, landed: 99 },
        100
      ),
      /synthetic progress refusal/
    );
  } finally {
    db.exec('DROP TRIGGER reject_progress_check');
  }
  assert.deepEqual(readIncident(), beforeRefusal);
  evidence.progressRollback = true;
  db.prepare('UPDATE neo_todos SET state=? WHERE id=?').run('doing', todoId);
  db.prepare('UPDATE neo_todo_sessions SET needs_you_since=NULL WHERE todo_id=?').run(todoId);
  const claims = await Promise.all([
    gateway.call(neoTodoSessionWrites, 'claimNeedsYou', todoId, 10),
    gateway.call(neoTodoSessionWrites, 'claimNeedsYou', todoId, 11),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean)?.id, todoId);
  assert.equal(readIncident()?.needs, 10);
  evidence.singleIncident = true;
  db.prepare('UPDATE neo_todo_sessions SET needs_you_since=NULL WHERE todo_id=?').run(todoId);
  const beforeIncidentRefusal = readIncident();
  db.exec(
    "CREATE TRIGGER reject_needs_you BEFORE UPDATE OF needs_you_since ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'synthetic incident refusal'); END"
  );
  try {
    await assert.rejects(
      gateway.call(neoTodoSessionWrites, 'claimNeedsYou', todoId, 12),
      /synthetic incident refusal/
    );
  } finally {
    db.exec('DROP TRIGGER reject_needs_you');
  }
  assert.deepEqual(readIncident(), beforeIncidentRefusal);
  evidence.incidentRollback = true;
  db.prepare('UPDATE neo_todos SET state=? WHERE id=?').run('done', todoId);
  const beforeClosedClaim = readIncident();
  assert.equal(await gateway.call(neoTodoSessionWrites, 'claimNeedsYou', todoId, 13), null);
  assert.deepEqual(readIncident(), beforeClosedClaim);
  evidence.closedIncidentRefused = true;
  evidence.pass = true;
} finally {
  try {
    await gateway?.close();
    evidence.gatewayClosed = gateway !== undefined;
  } finally {
    try {
      if (initialized) {
        core.close();
        evidence.databaseClosed = true;
      }
    } finally {
      writeFileSync(
        join(run, 'evidence/bun-todo-incident.json'),
        JSON.stringify(evidence, null, 2)
      );
    }
  }
}
