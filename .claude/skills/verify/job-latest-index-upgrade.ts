import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { runMigration445 } from '../../../packages/daemon/src/storage/schema/m445-job-queue-message-lookup-index.ts';

const run = resolve(process.argv[2]);
assert(run.startsWith('/private/tmp/hn-job-latest-'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
const db = new Database(join(run, 'data/daemon.db'));
try {
  assert(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_job_queue_message_lookup'").get());
  const digest = () => {
    const hash = createHash('sha256');
    let rows = 0;
    for (const row of db.prepare('SELECT * FROM job_queue ORDER BY id').iterate()) { hash.update(JSON.stringify(row)); rows++; }
    return { rows, sha256: hash.digest('hex') };
  };
  const before = digest();
  assert(before.rows >= 300000);
  const started = performance.now();
  runMigration445(db);
  const migrationMs = performance.now() - started;
  const after = digest();
  assert.deepEqual(after, before);
  runMigration445(db);
  assert.deepEqual(digest(), before);
  const result = { runtime: Bun.version, before, after, migrationMs, idempotent: true, index: db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_job_queue_message_lookup'").get(), limitation: 'Synthetic index-build startup cost, not proof of production duration or historical physical delay.' };
  writeFileSync(join(run, 'migration-observed.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { db.close(); }
