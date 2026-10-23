import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { runMigration447 } from '../../../packages/daemon/src/storage/schema/m447-neo-todo-removed-index.ts';

const run = resolve(process.argv[2]);
assert(run.startsWith('/private/tmp/hn-claims-'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
const db = new Database(join(run, 'data/daemon.db'));
try {
  assert(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_neo_todos_removed'").get());
  const digest = () => {
    const hash = createHash('sha256'); let todos=0, claims=0;
    for(const row of db.prepare('SELECT * FROM neo_todos ORDER BY id').iterate()) { hash.update(JSON.stringify(row));todos++; }
    for(const row of db.prepare('SELECT * FROM pack_coding_pr_claims ORDER BY todo_id,url').iterate()) { hash.update(JSON.stringify(row));claims++; }
    return {todos,claims,sha256:hash.digest('hex')};
  };
  const before=digest(), started=performance.now();
  runMigration447(db); const migrationMs=performance.now()-started;
  const after=digest(); assert.deepEqual(after,before);
  runMigration447(db); assert.deepEqual(digest(),before);
  const result={runtime:Bun.version,before,after,migrationMs,idempotent:true,index:db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_neo_todos_removed'").get(),limitation:'Synthetic index-build cost; no historical physical-cause or production-duration claim.'};
  writeFileSync(join(run,'migration-observed.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally { db.close(); }
