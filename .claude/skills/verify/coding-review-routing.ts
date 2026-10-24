import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'));
mkdirSync(join(run, 'data'));
const db = new Database(join(run, 'data/routing.db'));
const evidence: unknown[] = [];
try {
  createCodingPackTables(db);
  const pack = createCodingPack({
    database: () => db,
    todoPrs: new CodingTodoPrRepository(db),
    prLedger: new CodingPrLedgerRepository(db),
    prEvents: new CodingPrEventRepository(db),
    prSweep: new CodingPrSweepRepository(db),
    readPrs: async () => [],
    projectRepos: () => [],
    prSweepDeps: { tell: async () => true, wake: async () => true },
  });
  const calls: string[] = [];
  const effects = { startReviewer: async () => {
    calls.push('synthetic-review-assignment');
    writeFileSync(join(run, 'evidence/assignments.json'), JSON.stringify(calls));
    return 'synthetic-review-assignment';
  } };
  const reviewBot = 'synthetic-review-service';
  const reviews = [{ author: { login: reviewBot }, commit: { oid: 'head-1' }, state: 'APPROVED' }];
  const approved = await pack.review({ reviewBot, head: 'head-1', reviews }, effects);
  assert.deepEqual(approved, { kind: 'bot', head: 'head-1', login: reviewBot, approved: true });
  for (const state of ['COMMENTED', 'PENDING']) {
    const afterComment = await pack.review({ reviewBot, head: 'head-1', reviews: [
      ...reviews, { ...reviews[0], state },
    ] }, effects);
    assert.deepEqual(afterComment, approved);
    assert.equal(calls.length, 0);
    evidence.push({ state, afterComment, reviewerAssignments: [...calls] });
  }
  const pushed = await pack.review({ reviewBot, head: 'head-2', reviews }, effects);
  assert.deepEqual(pushed, { kind: 'bot', head: 'head-2', login: reviewBot, approved: false });
  const waiting = await pack.review({ reviewBot, head: 'head-2', reviews: [] }, effects);
  assert.equal(waiting.kind, 'bot');
  assert.equal(calls.length, 0);
  evidence.push({ approved, pushed, waiting, reviewerAssignments: [...calls] });
  const session = await pack.review({ head: 'head-2', reviews }, effects);
  assert.deepEqual(session, { kind: 'session', head: 'head-2', sessionId: 'synthetic-review-assignment' });
  assert.deepEqual(JSON.parse(readFileSync(join(run, 'evidence/assignments.json'), 'utf8')), ['synthetic-review-assignment']);
  evidence.push({ session, reviewerAssignments: [...calls] });
  console.log('PASS: configured bot stays on bot review across a push; no bot creates exactly one synthetic assignment');
} finally {
  writeFileSync(join(run, 'evidence/routing.json'), JSON.stringify(evidence, null, 2));
  db.close();
}
