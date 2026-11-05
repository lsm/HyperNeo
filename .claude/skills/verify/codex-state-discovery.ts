process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const args = process.argv.slice(2);
const run = resolve(args.at(-1)!);
const onlySix = args[0] === 'six-only';
const unavailable = args[0] === 'unavailable-home';
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const directory of ['evidence', 'bin', ...(unavailable ? [] : ['home/.codex'])]) mkdirSync(join(run, directory), { recursive: true });
for (const name of ['gh', 'ps', 'open']) {
  const path = join(run, 'bin', name);
  writeFileSync(path, '#!/bin/sh\nexit 1\n');
  chmodSync(path, 0o700);
}
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const folder = join(run, 'project');
const versions = unavailable ? [] : onlySix ? [6] : [5, 6, 10];
for (const version of versions) {
  const db = new Database(join(run, 'home/.codex', `state_${version}.sqlite`));
  db.exec(`CREATE TABLE projects(id TEXT, name TEXT, updated_at_ms INTEGER);
    CREATE TABLE project_roots(project_id TEXT, path TEXT);
    CREATE TABLE threads(id TEXT, name TEXT, title TEXT, first_user_message TEXT,
      cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER);
    INSERT INTO projects VALUES ('project', 'Synthetic', 1)`);
  db.prepare('INSERT INTO project_roots VALUES (?, ?)').run('project', folder);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(`worker-${version}`, `Worker ${version}`, '', '', folder, 'desktop', 0, version);
  db.close();
}
if (unavailable) writeFileSync(join(run, 'home/.codex'), 'Not a directory');
else {
  writeFileSync(join(run, 'home/.codex/state_99.sqlite-wal'), 'Unrelated sidecar');
  mkdirSync(join(run, 'home/.codex/state_20.sqlite'));
}
const newest = Math.max(...versions);
const statePath = join(run, 'home/.codex', `state_${newest}.sqlite`);
const hash = () => createHash('sha256').update(readFileSync(statePath)).digest('hex');
const before = unavailable ? null : hash();
const config = { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true };
assert.equal(config.disableWorktrees, true, 'the proof must explicitly disable worktrees');
const app = await createDaemonApp({ config, verbose: false });
const receipts: unknown[] = [];
async function find() {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), 'work.find', JSON.stringify({ adapters: ['codex-desktop'], localOnly: true })], {
    env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit',
  });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!result.reply.error, JSON.stringify(result));
  receipts.push(result.reply);
  writeFileSync(join(run, 'evidence/receipts.json'), JSON.stringify(receipts, null, 2));
  return result.reply;
}
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const found = await find();
  assert.deepEqual(found.unreachable, []);
  if (unavailable) {
    assert.deepEqual(found.places, []);
    writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ started: true, worktreesDisabled: config.disableWorktrees, found }, null, 2));
    console.log('PASS: daemon starts and discovery stays unavailable when the Codex home is not a directory');
  } else {
  assert.deepEqual(found.places.flatMap((place: { work: { ref: { id: string } }[] }) => place.work.map(work => work.ref.id)), [`worker-${newest}`]);
  assert.equal(hash(), before, 'discovery must not write the external state database');
  const broken = new Database(statePath);
  broken.exec('DROP TABLE project_roots');
  broken.close();
  const missingTable = await find();
  assert.equal(missingTable.unreachable[0]?.source, 'codex-desktop');
  assert.match(missingTable.unreachable[0]?.reason ?? '', /Unsupported Codex state schema:.*project_roots/);
  const repair = new Database(statePath);
  repair.exec('CREATE TABLE project_roots(project_id TEXT, path TEXT)');
  repair.prepare('INSERT INTO project_roots VALUES (?, ?)').run('project', folder);
  repair.exec('ALTER TABLE threads DROP COLUMN source');
  repair.close();
  const missingColumn = await find();
  assert.match(missingColumn.unreachable[0]?.reason ?? '', /Unsupported Codex state schema:.*source/);
  const restored = new Database(statePath);
  restored.exec('ALTER TABLE threads ADD COLUMN source TEXT');
  restored.close();
  const recovered = await find();
  assert.deepEqual(recovered.unreachable, []);
  assert.equal(recovered.places[0]?.work[0]?.ref.id, `worker-${newest}`);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ newest, found, missingTable, missingColumn, recovered, externalStateUnchangedByFind: true }, null, 2));
  console.log('PASS: newest Codex state is discoverable, incompatible schemas report their reason, and repair recovers');
  }
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true }));
}
