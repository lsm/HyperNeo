import { strict as assert } from 'node:assert';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const [mode, runText] = process.argv.slice(2);
assert(runText && ['reproduce', 'verify'].includes(mode));
const run = resolve(runText);
assert(process.env.NODE_ENV === 'test');
assert.equal(process.env.HOME, join(run, 'home'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const seedPath = join(run, 'synthetic.db');
assert(!existsSync(seedPath));
const seed = new Database(seedPath);
seed.exec(`CREATE VIRTUAL TABLE message_search_fts USING fts5(title, body, detail=column);
  INSERT INTO message_search_fts(message_search_fts, rank) VALUES('automerge', 0);
  INSERT INTO message_search_fts(message_search_fts, rank) VALUES('crisismerge', 16);`);
const insert = seed.prepare('INSERT INTO message_search_fts(title, body) VALUES (?, ?)');
let random = 42;
const words = Array.from({ length: 5000 }, (_, i) => `word${i}`);
for (let batch = 0; batch < 15; batch++) {
  seed.transaction(() => {
    for (let row = 0; row < 34000; row++) {
      const body = Array.from({ length: 256 }, () => {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        return words[random % words.length];
      }).join(' ');
      insert.run('synthetic', body);
    }
  })();
}
const matches = (db: Database) =>
  db.query("SELECT count(*) AS n FROM message_search_fts WHERE message_search_fts MATCH 'word42'").get();
const before = matches(seed);
seed.close();
const samples = [];
for (const rank of [64, 128, 1024]) {
  const path = join(run, `rank-${rank}.db`);
  copyFileSync(seedPath, path);
  const db = new Database(path);
  db.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  db.exec(`INSERT INTO message_search_fts(message_search_fts, rank) VALUES('merge', ${rank})`);
  db.exec('COMMIT');
  const lockMs = performance.now() - started;
  assert.deepEqual(matches(db), before);
  samples.push({ rank, lockMs });
  db.close();
}
const workerPath = join(run, 'worker.db');
copyFileSync(seedPath, workerPath);
const worker = new Worker(
  new URL('../../../packages/daemon/src/lib/message-search-merge-worker.ts', import.meta.url).href
);
const checked = new Database(workerPath);
checked.exec("INSERT INTO message_search_fts(message_search_fts, rank) VALUES('crisismerge', 1000)");
const totalChanges = () => (checked.query('SELECT total_changes() AS n').get() as { n: number }).n;
const segments = () =>
  (checked.query('SELECT count(DISTINCT segid) AS n FROM message_search_fts_idx').get() as { n: number }).n;
const initialSegments = segments();
const receipts = [];
let remainingChanges = 0;
try {
  for (let round = 0; round < 32; round++) {
    checked.transaction(() => {
      const add = checked.prepare('INSERT INTO message_search_fts(title, body) VALUES (?, ?)');
      for (let row = 0; row < 100; row++) add.run('incoming', 'backlog-marker '.repeat(256));
    })();
    const receipt = await new Promise<{ ok: boolean; lifecycle: { mergeMs: number } }>((done, fail) => {
      worker.onerror = fail;
      worker.onmessage = (event) => {
        if ('ok' in event.data) done(event.data);
      };
      worker.postMessage({ dbPath: workerPath });
    });
    assert(receipt.ok);
    receipts.push(receipt);
    checked.exec('BEGIN');
    const previous = totalChanges();
    checked.exec("INSERT INTO message_search_fts(message_search_fts, rank) VALUES('merge', 64)");
    remainingChanges = totalChanges() - previous;
    checked.exec('ROLLBACK');
    if (remainingChanges < 2) break;
  }
  assert.deepEqual(matches(checked), before);
} finally {
  worker.terminate();
}
const finalSegments = segments();
checked.close();
const report = { rows: 510000, wordsPerBody: 256, before, samples, initialSegments, finalSegments, remainingChanges, workerRuns: receipts.length, receipts };
writeFileSync(join(run, 'evidence/merge.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (mode === 'verify') {
  assert(samples[0].lockMs < samples[2].lockMs * 0.6, 'rank 64 must hold the writer substantially less than rank 1024');
  assert(remainingChanges < 2, 'background worker must drain eligible backlog despite incoming writes');
  assert(finalSegments < initialSegments, 'segment backlog must shrink');
}
