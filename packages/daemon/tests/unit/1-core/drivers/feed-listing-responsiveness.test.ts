import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexFeed } from '../../../../src/lib/drivers/codex-feed';
import { runClaudeFeed } from '../../../../src/lib/drivers/claude-feed';
import { pruneVanishedFeeds, withKnownFeedFiles } from '../../../../src/lib/drivers/work-feed';
import { createWorkFeedOffsetsTable } from '../../../../src/storage/schema/m302-work-index-kinds';
import type { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { readWorkFeedOffsets, saveWorkFeedChunk } from '../../../../src/storage/work-feed';

const delay = vi.hoisted(() => ({ path: '', operation: '', ms: 400 }));
vi.mock('node:fs', async (original) => {
  const { delayedFeedSync } = await import('../../../helpers/delayed-feed-fs');
  return delayedFeedSync(await original<typeof import('node:fs')>(), delay);
});
vi.mock('node:fs/promises', async (original) => {
  const { delayedFeedAsync } = await import('../../../helpers/delayed-feed-fs');
  return delayedFeedAsync(await original<typeof import('node:fs/promises')>(), delay);
});

let root: string;
let db: Database;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function responsive(run: () => unknown) {
  let last = performance.now();
  let maxLag = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last - 5);
    last = now;
  }, 5);
  try {
    await pause(15);
    const result = await run();
    await pause(15);
    expect(maxLag).toBeLessThan(200);
    return result;
  } finally {
    clearInterval(timer);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hn-feed-listing-'));
  db = new Database(':memory:');
  db.exec(`CREATE TABLE message_search_content (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT,
    message_id TEXT, session_id TEXT, task_id TEXT, space_id TEXT, task_number INTEGER,
    message_type TEXT, title TEXT, body TEXT, timestamp INTEGER, UNIQUE (kind, source_id));
    CREATE TABLE sessions (sdk_session_id TEXT);`);
  createWorkFeedOffsetsTable(db);
});
afterEach(() => {
  delay.path = '';
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test.each(['codex', 'claude'])('timed %s listing yields during slow metadata I/O', async (kind) => {
  const dir = join(root, 'project');
  mkdirSync(dir);
  const path = join(dir, 'synthetic.jsonl');
  writeFileSync(path, '{"type":"ignored"}\n');
  delay.path = root;
  delay.operation = 'list';
  const run = kind === 'codex' ? runCodexFeed : runClaudeFeed;
  const queue = { enqueueUniquePending: vi.fn() } as unknown as JobQueueRepository;
  expect(await responsive(() => run(queue, db, root, Date.now()))).toEqual({ files: 1, turns: 0 });
  expect([...readWorkFeedOffsets(db)]).toEqual([
    [
      path,
      {
        offset: statSync(path).size,
        size: statSync(path).size,
        mtime: Math.floor(statSync(path).mtimeMs),
      },
    ],
  ]);
});

test('pruning yields while checking a retained path and keeps its offset', async () => {
  const path = join(root, 'retained.jsonl');
  writeFileSync(path, 'retained');
  saveWorkFeedChunk(db, 'codex', '', [], path, { offset: 3, size: 8, mtime: 1 });
  const before = [...readWorkFeedOffsets(db)];
  delay.path = path;
  delay.operation = 'prune';
  expect(
    await responsive(() =>
      pruneVanishedFeeds(db, root, {
        kind: 'codex',
        sessionOf: () => 'retained',
        meta: () => null,
        turns: () => [],
      })
    )
  ).toEqual([]);
  expect([...readWorkFeedOffsets(db)]).toEqual(before);
});

test('known-file metadata yields and keeps descending order and unchanged file sizes', async () => {
  const path = join(root, 'known.jsonl');
  writeFileSync(path, 'known');
  const expected = { path, size: statSync(path).size, mtime: Math.floor(statSync(path).mtimeMs) };
  const listed = { path: join(root, 'listed.jsonl'), size: 7, mtime: expected.mtime - 1000 };
  delay.path = path;
  delay.operation = 'known';
  expect(
    await responsive(() => withKnownFeedFiles([listed], [path, listed.path, join(root, 'gone')]))
  ).toEqual([expected, listed]);
});
