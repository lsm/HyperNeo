import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const [portText, runText, rowsText = '500000', wordsText = '64', secondsText = '60'] =
  process.argv.slice(2);
const port = Number(portText);
const rows = Number(rowsText);
const bodyWords = Number(wordsText);
const seconds = Number(secondsText);
assert(port > 0 && port !== 8399 && runText && rows > 0 && bodyWords > 0 && seconds >= 0);
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
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const body = () =>
  Array.from({ length: bodyWords }, () => words[Math.floor(random() * words.length)]).join(' ');
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const app = await createDaemonApp({
  config: getConfig({ port, host: '127.0.0.1', dbPath }),
  verbose: false,
});
const db = app.db.getDatabase();
const insert = db.prepare(
  `INSERT INTO message_search_content (kind, source_id, session_id, title, body, timestamp)
   VALUES ('message', ?, 'synthetic', 'Synthetic', ?, ?)`
);
let next = 0;
const addRows = (count: number) => {
  const started = performance.now();
  db.transaction(() => {
    for (let i = 0; i < count; i++, next++) insert.run(`s-${next}`, body(), next);
  })();
  return performance.now() - started;
};
let maxLagMs = 0;
let last = performance.now();
const lag = setInterval(() => {
  const now = performance.now();
  maxLagMs = Math.max(maxLagMs, now - last - 10);
  last = now;
}, 10);
const indexStarted = performance.now();
const batches: number[] = [];
while (next < rows) {
  batches.push(addRows(Math.min(200, rows - next)));
  await pause(1);
}
const indexMs = performance.now() - indexStarted;
const indexLagMs = maxLagMs;
const search = db.prepare(
  `SELECT count(*) AS n FROM message_search_fts WHERE message_search_fts MATCH ?`
);
const queries: number[] = [];
let matches = 0;
for (const term of words.slice(0, 20)) {
  const started = performance.now();
  matches += (search.get(term) as { n: number }).n;
  queries.push(performance.now() - started);
}
const expiry = db.prepare(
  `UPDATE space_external_events SET state = 'failed', updated_at = ?
   WHERE state = 'published' AND created_at < ?
     AND NOT EXISTS (SELECT 1 FROM space_external_event_deliveries d WHERE d.event_id = space_external_events.id)`
);
maxLagMs = 0;
const writes: number[] = [];
const deadline = Date.now() + seconds * 1000;
while (Date.now() < deadline) {
  const started = performance.now();
  expiry.run(Date.now(), Date.now() - 86_400_000);
  addRows(20);
  writes.push(performance.now() - started);
  await pause(100);
}
clearInterval(lag);
const top = (values: number[]) => Math.round(Math.max(0, ...values));
const report = {
  surface:
    'in-process daemon on a synthetic DB with its own background merges; index writes of 200 rows yield between batches, then the space_external_events expiry UPDATE plus a 20-row index write every 100 ms',
  rows,
  bodyWords,
  index: { ms: Math.round(indexMs), batches: batches.length, worstBatchMs: top(batches), maxLagMs: Math.round(indexLagMs) },
  searchAfterIndexing: { queries: queries.length, maxMs: Math.round(Math.max(...queries) * 10) / 10, totalMatches: matches },
  steady: { seconds, writes: writes.length, worstWriteMs: top(writes), maxLagMs: Math.round(maxLagMs) },
  runtime: Bun.version,
};
writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await app.cleanup();
process.exit(0);
