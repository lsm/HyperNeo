import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobQueueRepository } from '../../src/storage/repositories/job-queue-repository';
import { createTables, runMigrations } from '../../src/storage/schema/index';
import { Database } from '../../src/storage/sqlite-compat';

const DAY_MS = 24 * 60 * 60 * 1000;
const FINISHED = Number(process.argv[2] ?? 75_000);
const EXPIRED = 400;
const SAMPLES = 5;
const ROW_RESULT = JSON.stringify({ ok: true, note: 'x'.repeat(260) });
const log = (message: string): void => process.stdout.write(`${message}\n`);

const VARIANTS: Record<string, string[]> = {
  'status only': [
    'DROP INDEX IF EXISTS idx_job_queue_status_completed',
    'CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status)',
  ],
  'status, completed_at': [
    'DROP INDEX IF EXISTS idx_job_queue_status',
    'CREATE INDEX IF NOT EXISTS idx_job_queue_status_completed ON job_queue(status, completed_at)',
  ],
};

const LIVE_STATS: Record<string, string> = {
  sqlite_autoindex_job_queue_1: '23875 1',
  idx_job_queue_dequeue: '23875 171 103 103 1',
  idx_job_queue_status: '23875 512',
  idx_job_queue_status_completed: '23875 512 1',
};

function insertJobs(db: Database, rows: [string, string, string, number][]): void {
  const insert = db.prepare(
    `INSERT INTO job_queue (id, queue, status, payload, result, priority, max_retries, retry_count, run_at, created_at, completed_at)
     VALUES (?, ?, ?, '{"sessionId":"session","path":"/feed"}', ?, 0, 3, 0, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const [id, queue, status, at] of rows)
      insert.run(id, queue, status, ROW_RESULT, at, at, at);
  })();
}

function withVariant(path: string, statements: string[]): void {
  const db = new Database(path);
  for (const sql of statements) db.exec(sql);
  db.exec('ANALYZE job_queue');
  const stat = db.prepare("UPDATE sqlite_stat1 SET stat = ? WHERE tbl = 'job_queue' AND idx = ?");
  for (const [idx, value] of Object.entries(LIVE_STATS)) stat.run(value, idx);
  db.close();
}

async function sample(path: string, now: number, round: number) {
  const seed = new Database(path);
  insertJobs(
    seed,
    Array.from({ length: EXPIRED }, (_, i) => [
      `old-${round}-${i}`,
      'work.feed.claude',
      'completed',
      now - 8 * DAY_MS - i,
    ])
  );
  seed.close();
  const db = new Database(path);
  const repository = new JobQueueRepository(db);
  let worstLag = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const at = performance.now();
    worstLag = Math.max(worstLag, at - last - 5);
    last = at;
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const started = performance.now();
  const deleted = repository.cleanup(now - 7 * DAY_MS);
  const statementMs = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 20));
  clearInterval(timer);
  const plan = (
    db
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM job_queue WHERE status IN ('completed', 'dead', 'failed') AND completed_at < ?`
      )
      .all(0) as { detail: string }[]
  )
    .map((row) => row.detail)
    .join('; ');
  db.close();
  return { deleted, statementMs, worstLag, plan };
}

const dir = mkdtempSync(join(tmpdir(), 'job-queue-cleanup-'));
try {
  const now = Date.now();
  const path = join(dir, 'daemon.db');
  const db = new Database(path);
  runMigrations(db, () => {});
  createTables(db);
  const queues = [
    'work.feed.codex',
    'work.feed.claude',
    'neo.work.driver.refresh',
    'mailbox.expire',
  ];
  insertJobs(
    db,
    Array.from({ length: FINISHED }, (_, i) => [
      `recent-${i}`,
      queues[i % queues.length],
      i % 12 ? 'completed' : 'dead',
      now - (i % 7) * DAY_MS + i,
    ])
  );
  db.close();
  log(
    `${FINISHED} finished jobs within retention, ${EXPIRED} past it per sample, live planner stats`
  );
  for (const [name, statements] of Object.entries(VARIANTS)) {
    withVariant(path, statements);
    const runs = [];
    for (let round = 0; round < SAMPLES; round++) runs.push(await sample(path, now, round));
    const statement = runs.map((run) => run.statementMs).sort((a, b) => a - b);
    log(
      `${name}: deleted ${runs[0].deleted}/run, statement median ${statement[SAMPLES >> 1].toFixed(1)} ms, max ${statement[SAMPLES - 1].toFixed(1)} ms, worst event-loop lag ${Math.max(...runs.map((run) => run.worstLag)).toFixed(1)} ms | ${runs[0].plan}`
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
