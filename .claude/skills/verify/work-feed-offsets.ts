import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkFeedOffsetsTable } from '../../../packages/daemon/src/storage/schema/m302-work-index-kinds.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { readWorkFeedOffsets, saveWorkFeedChunk } from '../../../packages/daemon/src/storage/work-feed.ts';

const ROWS = Number(process.argv[2] ?? 2_700);
const POLLS = Number(process.argv[3] ?? 35);
const dir = mkdtempSync(join(tmpdir(), 'feed-offsets-'));
const db = new Database(join(dir, 'd.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`CREATE TABLE message_search_content (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT,
  message_id TEXT, session_id TEXT, task_id TEXT, space_id TEXT, task_number INTEGER,
  message_type TEXT, title TEXT, body TEXT, timestamp INTEGER, UNIQUE (kind, source_id))`);
createWorkFeedOffsetsTable(db);
const insert = db.prepare('INSERT INTO work_feed_offsets (path, offset, size, mtime) VALUES (?, ?, ?, ?)');
db.transaction(() => {
  for (let i = 0; i < ROWS; i++)
    insert.run(`/Users/x/.claude/projects/-Users-x-focus-repo-${i % 90}/${crypto.randomUUID()}.jsonl`, i * 10, i * 10, i);
})();

let reads = 0;
const prepare = db.prepare.bind(db);
db.prepare = ((sql: string) => {
  if (/^\s*SELECT .* FROM work_feed_offsets/.test(sql)) reads++;
  return prepare(sql);
}) as typeof db.prepare;

const times: number[] = [];
for (let poll = 0; poll < POLLS; poll++) {
  const started = performance.now();
  const offsets = readWorkFeedOffsets(db);
  times.push(performance.now() - started);
  const [path, offset] = offsets.entries().next().value!;
  saveWorkFeedChunk(db, 'claude', 't', [], path, { ...offset, offset: offset.offset + 1 });
}
times.sort((a, b) => a - b);
console.log(
  `rows=${ROWS} polls=${POLLS} table reads=${reads} ` +
    `per-poll ms: median=${times[Math.floor(POLLS / 2)].toFixed(3)} max=${times.at(-1)!.toFixed(3)} ` +
    `total=${times.reduce((a, b) => a + b, 0).toFixed(1)}`
);
db.close();
rmSync(dir, { recursive: true, force: true });
