import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

await import('./lane-c-github-space-enabled-extract.ts');
const run = resolve(process.argv.at(-1)!);
const characterized = JSON.parse(readFileSync(join(run, 'evidence/github-space-enabled-extract.json'), 'utf8'));
assert.equal(characterized.pass, true);
assert.equal(characterized.publicRpc.mainStatementRuns, 0);
const evidence: Record<string, unknown> = { publicRpcCharacterization: characterized.publicRpc, mainThreadMovementClaim: false };
let db: import('../../../packages/daemon/src/storage/sqlite-compat.ts').Database | undefined;
try {
  const file = new URL('../../../packages/daemon/src/storage/repositories/github-space-settings-read.ts', import.meta.url);
  assert(existsSync(file), 'Constructor-free GitHub Space settings reads are unavailable');
  const { readGitHubSpaceEnabled, readGitHubPollingIntent, readGitHubFilterCurrentUser } = await import(file.href);
  const { Database } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
  db = new Database(':memory:');
  db.exec("CREATE TABLE space_github_source_settings(space_id TEXT PRIMARY KEY,enabled INTEGER,polling_intent INTEGER,filter_current_user INTEGER); INSERT INTO space_github_source_settings VALUES('synthetic-off',0,1,0),('synthetic-on',1,0,1),('synthetic-odd',2,-1,NULL); PRAGMA query_only=ON");
  for (const [key, expected] of [['missing', [true,false,true]], ['synthetic-off', [false,true,false]], ['synthetic-on',[true,false,true]], ['synthetic-odd',[false,false,false]]] as const) {
    assert.deepEqual([readGitHubSpaceEnabled(db,key), readGitHubPollingIntent(db,key), readGitHubFilterCurrentUser(db,key)], expected);
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM space_github_source_settings').get() as { n: number }).n, 3);
  evidence.constructorFreeQueryOnlyContract = true;
  evidence.pass = true;
} finally {
  db?.close();
  writeFileSync(join(run, 'evidence/github-space-settings-read.json'), JSON.stringify(evidence,null,2));
}
console.log('ok native GitHub Space RPC characterization and constructor-free query-only settings reads');
