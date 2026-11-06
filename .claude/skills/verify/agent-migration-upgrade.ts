import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
await import('./ask-markdown-http.ts');
const path = join(run, 'data/daemon.db');
const fixture = new Database(path);
const hashes = fixture.prepare("SELECT id, secret_hash FROM paired_devices WHERE kind='human' ORDER BY id").all();
try {
  fixture.exec("DELETE FROM paired_devices WHERE kind='agent'; DELETE FROM pairing_codes WHERE kind='agent'");
  for (const table of ['paired_devices', 'pairing_codes']) {
    const row = fixture.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(table) as { sql: string };
    const old = `${table}_legacy`;
    fixture.exec(row.sql.replace(table, old).replace(/,\s*'agent'/, ''));
    fixture.exec(`INSERT INTO ${old} SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${old} RENAME TO ${table}`);
  }
  fixture.exec("DELETE FROM migration_markers WHERE key='migration_481'; INSERT INTO work_sessions (adapter,id,name,status,updated_at,last_activity_at) VALUES ('synthetic','worker','Worker','idle',1,7)");
  assert(fixture.prepare("SELECT 1 FROM migration_markers WHERE key='migration_478'").get());
  assert.throws(() => fixture.exec("INSERT INTO paired_devices VALUES ('test','Reader','agent','test-hash',1,NULL,NULL,NULL)"));
} finally {
  fixture.close();
}
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: path }), disableWorktrees: true }, standalone: true, verbose: false });
try {
  await app.spaceRuntimeService?.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  assert.notEqual(app.server.port, 8399);
  const origin = `http://127.0.0.1:${app.server.port}`;
  const cli = Bun.spawn([process.execPath, 'packages/cli/main.ts', 'read', `${origin}/ask/synthetic.md`], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
  assert.equal(exit, 0, stderr);
  assert(stdout.startsWith('# Plan the visit\n'));
  const human = readLocalCredential(join(run, 'data/local-rpc.credential'));
  const response = await fetch(`${origin}/ask/synthetic.md`, { headers: { authorization: `Bearer ${human}` } });
  assert.equal(response.status, 200);
  const db = app.db.getDatabase();
  assert.deepEqual(db.prepare("SELECT id, secret_hash FROM paired_devices WHERE kind='human' ORDER BY id").all(), hashes);
  assert.deepEqual(db.prepare("SELECT status, last_activity_at FROM work_sessions WHERE id='worker'").get(), { status: 'idle', last_activity_at: 7 });
  for (const key of ['migration_478', 'migration_479', 'migration_480', 'migration_481']) assert(db.prepare('SELECT 1 FROM migration_markers WHERE key=?').get(key));
  writeFileSync(join(run, 'evidence/agent-upgrade.json'), JSON.stringify({ passed: true, fromWorkSessions478: true, agentMigration481: true, cliExit: exit, cardRead: true, humanRead: response.status, humanCredentialsPreserved: true, workSessionsPreserved: true }));
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/upgrade-cleanup.json'), JSON.stringify({ daemonStopped: true }));
}
