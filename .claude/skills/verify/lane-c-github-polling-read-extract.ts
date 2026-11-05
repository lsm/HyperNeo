import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

await import('./lane-c-github-polling-wiring.ts');
const run = resolve(process.argv.at(-1)!);
const characterized = JSON.parse(readFileSync(join(run, 'evidence/github-polling-wiring.json'), 'utf8'));
assert.equal(characterized.pass, true);
assert.equal(characterized.mainSqlAttempts, 0);
const evidence: Record<string, unknown> = { mainThreadMovementClaim: false, publicRpcCharacterization: characterized, contract: 'Constructor-free extraction only; callbacks still query on main pending reader command/wiring' };
let db: import('../../../packages/daemon/src/storage/sqlite-compat.ts').Database | undefined;
try {
  const file = new URL('../../../packages/daemon/src/storage/repositories/github-polling-repos-read.ts', import.meta.url);
  assert(existsSync(file), 'Constructor-free GitHub polling reads are unavailable');
  const { countGitHubSpacesWithPollingIntent, listGitHubPollingRepos, listGitHubPollingConfiguredRepos } = await import(file.href);
  const { Database } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
  const { SESSION_EVENT_SCOPE } = await import('../../../packages/daemon/src/lib/external-events/session-external-event-store.ts');
  const { createWatchedTable, insertWatchedRow } = await import('../../../packages/daemon/tests/unit/helpers/github-watched-read-fixture.ts');
  db = new Database(':memory:');
  db.exec("CREATE TABLE spaces(id TEXT PRIMARY KEY); INSERT INTO spaces VALUES('synthetic-space'); CREATE TABLE space_github_source_settings(space_id TEXT,enabled INTEGER,polling_intent INTEGER); INSERT INTO space_github_source_settings VALUES('synthetic-space',0,1),('orphan',1,1)");
  createWatchedTable(db);
  insertWatchedRow(db, { id: 'active', owner: 'Z' });
  insertWatchedRow(db, { id: 'disabled', owner: 'A', enabled: 0 });
  insertWatchedRow(db, { id: 'orphan', space_id: 'orphan' });
  insertWatchedRow(db, { id: 'session', space_id: SESSION_EVENT_SCOPE });
  const schema = db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
  const rows = db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all();
  db.exec('PRAGMA query_only=ON');
  assert.equal(countGitHubSpacesWithPollingIntent(db), 1);
  assert.deepEqual(listGitHubPollingRepos(db).map(r => r.id), ['orphan', 'session', 'active']);
  assert.deepEqual(listGitHubPollingConfiguredRepos(db).map(r => r.id), ['disabled', 'active']);
  assert.deepEqual(listGitHubPollingRepos(db, 'synthetic-space').map(r => r.id), ['active']);
  assert.deepEqual(listGitHubPollingRepos(db, ''), listGitHubPollingRepos(db));
  assert.deepEqual(listGitHubPollingConfiguredRepos(db, ''), listGitHubPollingConfiguredRepos(db));
  assert.deepEqual(listGitHubPollingConfiguredRepos(db, 'orphan'), []);
  assert.deepEqual(listGitHubPollingRepos(db, SESSION_EVENT_SCOPE).map(r => r.id), ['session']);
  assert.deepEqual(listGitHubPollingConfiguredRepos(db, SESSION_EVENT_SCOPE), []);
  assert.deepEqual(listGitHubPollingRepos(db, 'missing'), []);
  assert.deepEqual(db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all(), rows);
  assert.deepEqual(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), schema);
  evidence.constructorFreeQueryOnlyContract = true;
  evidence.pass = true;
} finally {
  db?.close();
  writeFileSync(join(run, 'evidence/github-polling-read-extract.json'), JSON.stringify(evidence,null,2));
}
console.log('ok native polling RPC and constructor-free polling query contracts; public callback reads remain main-side');
