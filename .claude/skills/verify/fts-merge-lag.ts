import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { runMessageSearchMerge } from '../../../packages/daemon/src/lib/message-search-merge.ts';
import { Database as BunDatabase } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const [portText, runText, rowsText = '500000', secondsText = '90', everyText = '30000', wordsText = '64'] =
  process.argv.slice(2);
const bodyWords = Number(wordsText);
const mergeEveryMs = Number(everyText);
const port = Number(portText);
const rows = Number(rowsText);
const seconds = Number(secondsText);
assert(port > 0 && port !== 8399 && runText && rows > 0 && seconds > 0);
const run = resolve(runText);
assert(process.env.NODE_ENV === 'test');
assert(process.env.HOME === join(run, 'home'));
assert(process.env.HYPERNEO_DATA_DIR === join(run, 'data'));
const dbPath = join(run, 'data/daemon.db');
assert(!existsSync(dbPath), 'requires a fresh synthetic database');
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'home'), { recursive: true });

const words = Array.from({ length: 5000 }, (_, i) => `w${(i * 7919).toString(36)}`);
let seed = 42;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const body = () => Array.from({ length: bodyWords }, () => words[Math.floor(random() * words.length)]).join(' ');
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false });
const db = app.db.getDatabase();
const insert = db.prepare(
  `INSERT INTO message_search_content (kind, source_id, session_id, title, body, timestamp)
   VALUES ('message', ?, 'synthetic', 'Synthetic', ?, ?)`
);
let next = 0;
const addRows = (count: number) =>
  db.transaction(() => {
    for (let i = 0; i < count; i++, next++) insert.run(`s-${next}`, body(), next);
  })();
const seedStarted = performance.now();
let seedBatchMaxMs = 0;
while (next < rows) {
  const started = performance.now();
  addRows(Math.min(200, rows - next));
  seedBatchMaxMs = Math.max(seedBatchMaxMs, performance.now() - started);
}
const seedMs = performance.now() - seedStarted;
const probeSql = `SELECT max(rowid) AS n FROM message_search_fts_data`;
const ftsPagesBefore = (db.prepare(probeSql).get() as { n: number }).n;

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const writes: number[] = [];
const merges: { status: string; ms: number }[] = [];
let maxLagMs = 0;
let last = performance.now();
const lag = setInterval(() => {
  const now = performance.now();
  maxLagMs = Math.max(maxLagMs, now - last - 10);
  last = now;
}, 10);
const expiry = db.prepare(
  `UPDATE space_external_events SET state = 'failed', updated_at = ?
   WHERE state = 'published' AND created_at < ?
     AND NOT EXISTS (SELECT 1 FROM space_external_event_deliveries d WHERE d.event_id = space_external_events.id)`
);
const deadline = Date.now() + seconds * 1000;
let merging = true;
const mergeLoop = (async () => {
  while (merging && Date.now() < deadline) {
    const started = performance.now();
    const status = await runMessageSearchMerge(dbPath).promise;
    merges.push({ status, ms: Math.round(performance.now() - started) });
    await pause(mergeEveryMs);
  }
})();
while (Date.now() < deadline) {
  const started = performance.now();
  expiry.run(Date.now(), Date.now() - 86_400_000);
  addRows(20);
  writes.push(performance.now() - started);
  await pause(100);
}
merging = false;
await mergeLoop;
clearInterval(lag);

const direct = new BunDatabase(dbPath);
direct.exec('PRAGMA busy_timeout = 5000');
const steps: number[] = [];
const changes = () => (direct.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
for (let i = 0; i < 200; i++) {
  const before = changes();
  const started = performance.now();
  direct.exec(`INSERT INTO message_search_fts(message_search_fts, rank) VALUES('merge', 1024)`);
  steps.push(performance.now() - started);
  if (changes() - before < 2) break;
}
direct.close();
const match = (db.prepare(`SELECT count(*) AS n FROM message_search_fts WHERE message_search_fts MATCH ?`).get(words[7]) as { n: number }).n;
const sorted = [...writes].sort((a, b) => a - b);
const report = {
  surface: 'in-process daemon on a synthetic DB; real merge worker every mergeEveryMs; main thread runs the space_external_events expiry UPDATE plus a 20-row index write every 100 ms',
  rows,
  seedMs: Math.round(seedMs),
  seedBatchMaxMs: Math.round(seedBatchMaxMs),
  mergeEveryMs,
  bodyWords,
  ftsDataMaxRowidBefore: ftsPagesBefore,
  seconds,
  maxLagMs: Math.round(maxLagMs),
  mainWriteMs: { count: sorted.length, p50: Math.round(sorted[Math.floor(sorted.length / 2)]), max: Math.round(sorted.at(-1) ?? 0) },
  merges: { count: merges.length, maxMs: Math.max(0, ...merges.map((m) => m.ms)), statuses: [...new Set(merges.map((m) => m.status))] },
  leftoverMergeStepMs: { count: steps.length, maxMs: Math.round(Math.max(0, ...steps)) },
  sampleMatchCount: match,
  runtime: Bun.version,
};
writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await app.cleanup();
process.exit(0);
