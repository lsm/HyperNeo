import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseCore } from '../packages/daemon/src/storage/database-core.ts';
import { DbGateway } from '../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { jobQueueWrites } from '../packages/daemon/src/storage/repositories/job-queue-repository.ts';
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
let holder: Worker | undefined;
const barrier = new SharedArrayBuffer(8);
const state = new Int32Array(barrier);
const until = async (ready: () => boolean) => {
  const end = Date.now() + 5000;
  while (!ready()) {
    assert(Date.now() < end, 'Timed out waiting for native lock holder');
    await new Promise((done) => setTimeout(done, 10));
  }
};
const evidence = {
  runtime: 'bun',
  startupBodyCopyComplete: false,
  holderReady: false,
  lockOwned: false,
  claimWaitedForRelease: false,
  holderCommitted: false,
  singleClaimPayload: false,
  holderTerminated: false,
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
  assert.deepEqual(await gateway.call(jobQueueWrites, 'dequeue', 'synthetic-claim', 5), []);
  db.exec('CREATE TABLE synthetic_writer(value INTEGER); INSERT INTO synthetic_writer VALUES (0)');
  const now = Date.now();
  db.prepare(
    'INSERT INTO job_queue(id,queue,status,payload,run_at,created_at) VALUES(?,?,?,?,?,?)'
  ).run(
    'bun-claim',
    'synthetic-claim',
    'pending',
    JSON.stringify({ body: 'complete claim payload' }),
    now,
    now
  );
  let holderReady = false;
  let holderResult: { committed?: true; error?: string } | undefined;
  holder = new Worker(
    new URL('../.claude/skills/verify/spawn-fixture-writer.ts', import.meta.url).href,
    { type: 'module' }
  );
  holder.onmessage = ({ data }) => {
    if (data.ready) holderReady = true;
    else holderResult = data;
  };
  holder.onerror = (event) => {
    holderResult = { error: event.message };
  };
  holder.postMessage({ dbPath: path, barrier, hold: true });
  await until(() => holderReady || holderResult !== undefined);
  assert.equal(holderResult, undefined, JSON.stringify(holderResult));
  assert(holderReady);
  evidence.holderReady = true;
  db.exec('PRAGMA busy_timeout=0');
  try {
    assert.throws(
      () => db.exec('BEGIN IMMEDIATE'),
      /database is locked/,
      'Native holder must own write lock'
    );
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.exec('PRAGMA busy_timeout=5000');
  }
  evidence.lockOwned = true;
  let settled = false;
  const pending = gateway.call(jobQueueWrites, 'dequeue', 'synthetic-claim', 5);
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(settled, false, 'Claim must remain pending while writer holds lock');
  assert.equal(
    db.prepare('SELECT status FROM job_queue WHERE id=?').get('bun-claim')?.status,
    'pending'
  );
  evidence.claimWaitedForRelease = true;
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
  const claimed = await pending;
  await until(() => holderResult !== undefined);
  assert.deepEqual(holderResult, { committed: true });
  assert.equal(db.prepare('SELECT value FROM synthetic_writer').get()?.value, 1);
  evidence.holderCommitted = true;
  assert.equal(claimed.length, 1);
  assert(claimed[0]?.claimToken);
  assert.deepEqual(claimed[0]?.payload, { body: 'complete claim payload' });
  assert.deepEqual(await gateway.call(jobQueueWrites, 'dequeue', 'synthetic-claim', 5), []);
  evidence.singleClaimPayload = true;
  evidence.pass = true;
} finally {
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
  holder?.terminate();
  evidence.holderTerminated = holder !== undefined;
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
      writeFileSync(join(run, 'evidence/bun-claim-lock.json'), JSON.stringify(evidence, null, 2));
    }
  }
}
