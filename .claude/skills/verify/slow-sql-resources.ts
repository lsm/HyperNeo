import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDaemonLagDiagnostics } from '../../../packages/daemon/src/lib/event-loop-lag.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const dbPath = join(run, 'data/proof.db');
assert(!existsSync(dbPath));
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'home'), { recursive: true });
const records: Record<string, unknown>[] = [];
let measuring = false;
const off = subscribeToStructuredLogs((event) => {
  if (
    measuring &&
    event.module === 'hyperneo:daemon:sqlite.query' &&
    event.metadata.event === 'slow'
  )
    records.push(event.metadata);
});
const db = new Database(dbPath, {
  queryObservability: {
    slowThresholdMs: 250,
    summaryIntervalMs: 0,
    maxQueryGroups: 10,
    summaryQueryLimit: 5,
  },
});
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; CREATE TABLE proof (id INTEGER)');
const query = db.prepare(
  'WITH RECURSIVE counter(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM counter WHERE n<?) SELECT SUM(n) AS total FROM counter'
);
const at = performance.now();
query.get(1_000_000);
const count = Math.round((1_000_000 * 600) / (performance.now() - at));
const warnings: string[] = [];
const stop = startDaemonLagDiagnostics({ onMessage: () => () => {} }, (line) =>
  warnings.push(line)
);
const pause = () => new Promise((done) => setTimeout(done, 300));
let writer: ReturnType<typeof spawn> | undefined;
let exited: Promise<unknown> | undefined;
try {
  await pause();
  measuring = true;
  writer = spawn(
    '/usr/bin/python3',
    [
      '-c',
      `import sqlite3,sys,time
db=sqlite3.connect(sys.argv[1])
db.execute('BEGIN IMMEDIATE')
print('locked',flush=True)
time.sleep(0.6)
db.rollback()
db.close()
`,
      dbPath,
    ],
    {
      env: { HOME: join(run, 'home'), PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'inherit'],
    }
  );
  exited = once(writer, 'exit');
  await once(writer.stdout!, 'data');
  db.prepare('INSERT INTO proof VALUES (?)').run(1);
  await exited;
  await pause();
  const row = query.get(count) as { total: number };
  assert.equal(row.total, (count * (count + 1)) / 2);
  await pause();
  stop();
  const report = {
    surface: 'daemon structured slow-SQL logs from real Bun SQLite executions',
    records,
    warnings,
    inserted: db.prepare('SELECT COUNT(*) AS n FROM proof').get(),
  };
  writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.resourceScope, 'event_loop_tick');
    assert(Number(record.tickEndMs) > Number(record.tickStartMs));
    assert(record.resources);
  }
  const wait = records[0].resources as { offCpuMs: number };
  const cpu = records[1].resources as { threadCpuMs: number };
  assert(wait.offCpuMs > 400, 'held synthetic writer must read as off-CPU wait');
  assert(cpu.threadCpuMs > 250, 'recursive SQL must read as main-thread CPU');
} finally {
  stop();
  if (writer?.exitCode === null && writer.signalCode === null) writer.kill();
  await exited;
  off();
  db.close();
}
