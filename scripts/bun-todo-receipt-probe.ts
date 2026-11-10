import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseCore } from '../packages/daemon/src/storage/database-core.ts';
import { DbGateway } from '../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { neoTodoReads } from '../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import {
  neoTodoSessionReads,
  neoTodoSessionWrites,
} from '../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
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
  bootstrapReceipt: false,
  liveStatus: false,
  dispatchReceipt: false,
  dispatchRollback: false,
  readerSnapshots: false,
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
  const askId = 'bun-todo-ask',
    todoId = 'bun-todo';
  db.prepare(
    'INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES(?,?,?,?,1,1)'
  ).run(askId, 'bun-root', 'Synthetic todo', 'Observe');
  db.prepare(
    'INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,started_at,created_at,updated_at) VALUES(?,?,0,?,?,?,1,1,1)'
  ).run(todoId, askId, 'Synthetic step', 'Observed', 'doing');
  db.prepare('INSERT INTO neo_todo_sessions(todo_id,target) VALUES(?,?)').run(todoId, '{}');
  assert.equal(
    await gateway.call(
      neoTodoSessionWrites,
      'recordLive',
      'bun-bootstrap-missing',
      'running',
      undefined
    ),
    false
  );
  assert.equal(
    db
      .prepare('SELECT COUNT(*) AS n FROM message_send_receipts WHERE key = ? AND fingerprint = ?')
      .get('neo-turn-report:v2:cutoff', 'v2')?.n,
    1
  );
  evidence.bootstrapReceipt = true;
  const starts = await gateway.call(neoTodoSessionReads, 'unrecordedStarts');
  const reports = await gateway.call(neoTodoSessionReads, 'awaitingReports');
  assert(starts.includes(todoId));
  assert(!reports.some((row) => row.todoId === todoId));
  assert(await gateway.call(neoTodoSessionWrites, 'recordLive', todoId, 'running', undefined));
  assert.equal(
    await gateway.call(neoTodoSessionWrites, 'recordLive', todoId, 'running', undefined),
    false
  );
  assert.equal(
    db.prepare('SELECT live_status AS status FROM neo_todo_sessions WHERE todo_id=?').get(todoId)
      ?.status,
    'running'
  );
  evidence.liveStatus = true;
  const dispatched = await gateway.call(neoTodoSessionWrites, 'recordDispatch', {
    todoId,
    askId,
    ref: { adapter: 'hyperneo', id: 'bun-worker' },
    startedAt: 2,
    observed: { model: 'synthetic-model', effort: 'high' },
    keepIdentity: false,
    sent: { inputBefore: 0, opening: 'Complete synthetic instruction' },
  });
  const readReceipt = db.prepare(
    'SELECT ref,actual_model,sent_opening FROM neo_todo_sessions WHERE todo_id=?'
  );
  const receipt = readReceipt.get(todoId);
  assert(dispatched.askOpen);
  assert.equal(dispatched.todo?.id, todoId);
  assert.equal(JSON.parse(String(receipt?.ref)).id, 'bun-worker');
  assert.equal(receipt?.actual_model, 'synthetic-model');
  assert.equal(receipt?.sent_opening, 'Complete synthetic instruction');
  evidence.dispatchReceipt = true;
  db.exec(
    "CREATE TRIGGER reject_todo_receipt BEFORE UPDATE OF sent_opening ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END"
  );
  try {
    await assert.rejects(
      gateway.call(neoTodoSessionWrites, 'recordDispatch', {
        todoId,
        askId,
        ref: { adapter: 'hyperneo', id: 'rejected-worker' },
        observed: {},
        keepIdentity: true,
        sent: null,
      }),
      /synthetic refusal/
    );
  } finally {
    db.exec('DROP TRIGGER reject_todo_receipt');
  }
  assert.deepEqual(readReceipt.get(todoId), receipt);
  evidence.dispatchRollback = true;
  const cards = await gateway.call(neoTodoReads, 'snapshot', undefined, 50);
  const page = await gateway.call(neoTodoReads, 'doneTodoFacts', 'bun-read-missing');
  const checks = await gateway.call(neoTodoReads, 'listCheckable');
  assert(Array.isArray(cards.asks));
  assert(cards.facts.links instanceof Map);
  assert.equal(page.ask, null);
  assert.deepEqual(page.todos, []);
  assert(Array.isArray(checks));
  evidence.readerSnapshots = true;
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
      writeFileSync(join(run, 'evidence/bun-todo-receipt.json'), JSON.stringify(evidence, null, 2));
    }
  }
}
