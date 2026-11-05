import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createWatchedTable, insertWatchedRow, mappedWatchedRow } from '../../../packages/daemon/tests/unit/helpers/github-watched-read-fixture.ts';

await import('./lane-c-github-space-settings-read.ts');
const run = resolve(process.argv.at(-1)!);
const characterized = JSON.parse(readFileSync(join(run,'evidence/github-space-settings-read.json'),'utf8'));
assert.equal(characterized.pass,true);
const evidence: Record<string,unknown> = { publicRpcCharacterization: characterized.publicRpcCharacterization, mainThreadMovementClaim: false };
let db: import('../../../packages/daemon/src/storage/sqlite-compat.ts').Database | undefined;
try {
  const file = new URL('../../../packages/daemon/src/storage/repositories/github-watched-repos-read.ts',import.meta.url);
  assert(existsSync(file),'Constructor-free GitHub watched repository reads are unavailable');
  const { listGitHubWatchedRepos } = await import(file.href);
  const { Database } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
  db = new Database(':memory:');
  createWatchedTable(db);
  insertWatchedRow(db);
  insertWatchedRow(db,{id:'synthetic-two',owner:'OwnerA',repo:'repo-a'});
  insertWatchedRow(db,{id:'synthetic-other',space_id:'another-space'});
  db.exec('PRAGMA query_only=ON');
  const rows = listGitHubWatchedRepos(db,'synthetic-space');
  assert.deepEqual(rows.map((row:{id:string})=>row.id),['synthetic-two','synthetic-one']);
  assert.deepEqual(rows[1],mappedWatchedRow);
  assert.equal(listGitHubWatchedRepos(db).length,3);
  assert.deepEqual(listGitHubWatchedRepos(db,''),listGitHubWatchedRepos(db));
  assert.deepEqual(listGitHubWatchedRepos(db,'missing'),[]);
  db.exec('PRAGMA query_only=OFF');
  db.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run('{broken','synthetic-one');
  db.exec('PRAGMA query_only=ON');
  assert.throws(()=>listGitHubWatchedRepos(db!,'synthetic-space'),SyntaxError);
  evidence.constructorFreeQueryOnlyRows = true;
  evidence.completeRowOrderAndCursorErrorsPreserved = true;
  evidence.pass=true;
} finally {
  db?.close();
  writeFileSync(join(run,'evidence/github-watched-repos-read.json'),JSON.stringify(evidence,null,2));
}
console.log('ok real GitHub Space RPC characterization and native constructor-free watched-row projection/order/cursor errors');
