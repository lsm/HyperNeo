import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseCore } from '../packages/daemon/src/storage/database-core.ts';
import { Database } from '../packages/daemon/src/storage/sqlite-compat.ts';
import { SDKStatusReader } from '../packages/daemon/src/storage/sdk-status-reader.ts';
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
let reader: SDKStatusReader | undefined;
const evidence = {
  runtime: 'bun',
  startupBodyCopyComplete: false,
  pendingTurnRoundTrip: false,
  codexSnapshot: false,
  externalFailurePreservesQueuedSdkRead: false,
  readerClosed: false,
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
  const body = 'Complete synthetic turn-range history';
  const id = Number(
    db
      .prepare(
        'INSERT INTO message_search_content(kind,source_id,session_id,message_type,title,body,timestamp) VALUES (?,?,?,?,?,?,?)'
      )
      .run('message', 'bun-turn-range', 'synthetic', 'user', 'Synthetic', body, 1).lastInsertRowid
  );
  reader = new SDKStatusReader(path);
  const rows = await reader.readPendingTurns('synthetic-model', 3, 32);
  assert(rows.some((row) => row.id === id && row.text === body && row.bodyLength === body.length));
  assert.equal(await reader.countPendingTurns('synthetic-model', 3), rows.length);
  evidence.pendingTurnRoundTrip = true;
  const externalPath = path + '.codex';
  const external = new Database(externalPath);
  try {
    external.exec(
      'CREATE TABLE projects(id TEXT,name TEXT,updated_at_ms INTEGER); CREATE TABLE project_roots(project_id TEXT,path TEXT); CREATE TABLE threads(id TEXT,name TEXT,title TEXT,first_user_message TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at_ms INTEGER)'
    );
    external.prepare('INSERT INTO projects VALUES (?,?,?)').run('p1', 'Synthetic Codex', 1);
    external.prepare('INSERT INTO project_roots VALUES (?,?)').run('p1', '/synthetic');
    external
      .prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)')
      .run('t1', 'Complete thread', '', 'Full retained history', '/synthetic', 'vscode', 0, 2);
  } finally {
    external.close();
  }
  const snapshot = await reader.readCodexSnapshot(externalPath, false);
  assert.equal(snapshot.roots[0]?.projectId, 'p1');
  assert.equal(snapshot.folders[0]?.openCount, 1);
  assert.equal(snapshot.threads[0]?.id, 't1');
  evidence.codexSnapshot = true;
  const failed = reader.readCodexSnapshot(externalPath + '.missing', false).then(
    () => false,
    () => true
  );
  const status = reader.read({ sessionId: 'synthetic-empty', status: 'consumed', limit: 1 });
  assert.equal(await failed, true);
  assert.equal((await status).total, 0);
  evidence.externalFailurePreservesQueuedSdkRead = true;
  evidence.pass = true;
} finally {
  try {
    await reader?.close();
    evidence.readerClosed = reader !== undefined;
  } finally {
    try {
      if (initialized) {
        core.close();
        evidence.databaseClosed = true;
      }
    } finally {
      writeFileSync(
        join(run, 'evidence/bun-shared-reader.json'),
        JSON.stringify(evidence, null, 2)
      );
    }
  }
}
