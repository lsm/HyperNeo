import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseCore } from '../packages/daemon/src/storage/database-core.ts';
import { DbGateway } from '../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { createCodingPackTables } from '../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';
import { codingTodoPrReads } from '../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
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
  reminderContext: false,
  singleReservation: false,
  reservationReleased: false,
  newerActivityPreserved: false,
  waitingDecisions: false,
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
  createCodingPackTables(db, 1);
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
  const id = 'bun-reminder',
    askId = 'bun-reminder-ask';
  const ref = { adapter: 'hyperneo', id: 'bun-reminder-worker' };
  const live = { status: 'stopped' as const, lastActivityAt: 1 };
  db.prepare(
    'INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES(?,?,?,?,1,1)'
  ).run(askId, 'bun-root', 'Synthetic reminder', 'Observe');
  db.prepare(
    'INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,instruction,created_at,updated_at) VALUES(?,?,0,?,?,?,?,1,1)'
  ).run(id, askId, 'Synthetic step', 'Observed', 'doing', 'Continue synthetic work');
  db.prepare('INSERT INTO neo_todo_sessions(todo_id,target,ref) VALUES(?,?,?)').run(
    id,
    JSON.stringify({ verb: 'send', ref }),
    JSON.stringify(ref)
  );
  const context = await gateway.call(neoTodoSessionReads, 'nudgeContext', id);
  assert.equal(context?.todo.instruction, 'Continue synthetic work');
  evidence.reminderContext = true;
  const writer = gateway;
  const claims = await Promise.all(
    [1, 2].map(() =>
      writer.call(neoTodoSessionWrites, 'claimNudge', id, ref, live, 1200001, 1, false)
    )
  );
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean)?.plan.nudges, 1);
  evidence.singleReservation = true;
  await gateway.call(neoTodoSessionWrites, 'finishNudge', id, 1, 1, 0);
  assert(await gateway.call(neoTodoSessionWrites, 'claimNudge', id, ref, live, 1200001, 1, false));
  evidence.reservationReleased = true;
  db.prepare('UPDATE pack_facts SET value_json=? WHERE todo_id=? AND pack=? AND key=?').run(
    JSON.stringify({ since: 99, nudges: 0 }),
    id,
    'core',
    'nudge'
  );
  await gateway.call(neoTodoSessionWrites, 'finishNudge', id, 1, 1, 3);
  const incident = JSON.parse(
    String(
      db
        .prepare('SELECT value_json FROM pack_facts WHERE todo_id=? AND pack=? AND key=?')
        .get(id, 'core', 'nudge')?.value_json
    )
  );
  assert.deepEqual(incident, { since: 99, nudges: 0 });
  evidence.newerActivityPreserved = true;
  assert.equal(await gateway.call(codingTodoPrReads, 'isWaiting', 'bun-waiting-missing'), false);
  for (const state of ['OPEN', 'CLOSED', 'MERGED']) {
    const prs = [
      { url: 'https://github.com/example/synthetic/pull/1', state, checks: 'none', review: 'none' },
    ];
    db.prepare(
      'INSERT OR REPLACE INTO pack_coding_todo_prs(todo_id,prs_json,read_at) VALUES(?,?,1)'
    ).run(id, JSON.stringify(prs));
    assert.equal(await gateway.call(codingTodoPrReads, 'isWaiting', id), state === 'OPEN');
  }
  evidence.waitingDecisions = true;
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
      writeFileSync(join(run, 'evidence/bun-reminder.json'), JSON.stringify(evidence, null, 2));
    }
  }
}
