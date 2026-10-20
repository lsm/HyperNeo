import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTables, runMigrations } from '../../src/storage/schema/index';
import { Database } from '../../src/storage/sqlite-compat';

const JOBS = Number(process.argv[2] ?? 75_000);
const SAMPLES = 50;
const log = (message: string): void => process.stdout.write(`${message}\n`);

const LATEST_SQL = `SELECT id AS job_id
  FROM job_queue
  WHERE queue = 'message_delivery'
    AND json_extract(payload, '$.sessionId') = ?
    AND json_extract(payload, '$.messageUuid') = ?
  ORDER BY created_at DESC, rowid DESC
  LIMIT 1`;

const VARIANTS: Record<string, string[]> = {
  'without messageUuid index': ['DROP INDEX IF EXISTS idx_message_delivery_message'],
  'with messageUuid index': [
    `CREATE INDEX IF NOT EXISTS idx_message_delivery_message
       ON job_queue (json_extract(payload, '$.messageUuid')) WHERE queue = 'message_delivery'`,
  ],
};

const LIVE_STATS: Record<string, string> = {
  sqlite_autoindex_job_queue_1: '23875 1',
  idx_job_queue_dequeue: '23875 171 103 103 1',
};

function seed(path: string): void {
  const db = new Database(path);
  runMigrations(db, () => {});
  createTables(db);
  const insert = db.prepare(
    `INSERT INTO job_queue (id, queue, status, payload, result, priority, max_retries, retry_count, run_at, created_at, completed_at)
     VALUES (?, ?, 'completed', ?, '{"ok":true}', 0, 3, 0, ?, ?, ?)`
  );
  db.transaction(() => {
    for (let i = 0; i < JOBS; i++) {
      const delivery = i % 7 === 0;
      const payload = delivery
        ? JSON.stringify({
            sessionId: `s${i % 300}`,
            messageUuid: `m${i}`,
            released: true,
            origin: 'chat',
            pad: 'x'.repeat(200),
          })
        : JSON.stringify({ sessionId: `s${i % 300}`, path: '/feed', pad: 'x'.repeat(200) });
      insert.run(`j${i}`, delivery ? 'message_delivery' : 'work.feed.claude', payload, i, i, i);
    }
  })();
  db.close();
}

const dir = mkdtempSync(join(tmpdir(), 'delivery-latest-job-'));
try {
  log(
    `${JOBS} completed jobs, ${Math.ceil(JOBS / 7)} of them message_delivery, live planner stats`
  );
  for (const [name, statements] of Object.entries(VARIANTS)) {
    const path = join(dir, `${name.replace(/\W+/g, '-')}.db`);
    seed(path);
    const setup = new Database(path);
    for (const sql of statements) setup.exec(sql);
    setup.exec('ANALYZE job_queue');
    const stat = setup.prepare(
      "UPDATE sqlite_stat1 SET stat = ? WHERE tbl = 'job_queue' AND idx = ?"
    );
    for (const [idx, value] of Object.entries(LIVE_STATS)) stat.run(value, idx);
    setup.close();
    const read = new Database(path);
    const lookup = read.prepare(LATEST_SQL);
    const plan = (
      read.prepare(`EXPLAIN QUERY PLAN ${LATEST_SQL}`).all('s0', 'm0') as { detail: string }[]
    )
      .map((row) => row.detail)
      .join('; ');
    let worstLag = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const at = performance.now();
      worstLag = Math.max(worstLag, at - last - 5);
      last = at;
    }, 5);
    const times: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const n = Math.floor((i * JOBS) / SAMPLES / 7) * 7;
      await new Promise((resolve) => setTimeout(resolve, 6));
      const started = performance.now();
      lookup.get(`s${n % 300}`, `m${n}`);
      times.push(performance.now() - started);
    }
    clearInterval(timer);
    read.close();
    times.sort((a, b) => a - b);
    log(
      `${name}: median ${times[SAMPLES >> 1].toFixed(2)} ms, max ${times[SAMPLES - 1].toFixed(2)} ms, worst event-loop lag ${worstLag.toFixed(1)} ms | ${plan}`
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
