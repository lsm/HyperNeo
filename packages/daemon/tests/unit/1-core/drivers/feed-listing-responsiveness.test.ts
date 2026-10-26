import { attachNativeFeedWriter } from '../../../helpers/native-feed-enqueue-writer';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexFeed } from '../../../../src/lib/drivers/codex-feed';
import { runClaudeFeed } from '../../../../src/lib/drivers/claude-feed';
import {
  listFeedFilesAsync,
  pruneVanishedFeeds,
  vanishedFeedPaths,
  withKnownFeedFiles,
} from '../../../../src/lib/drivers/work-feed';
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
  const queue = attachNativeFeedWriter({
    enqueueUniquePending: vi.fn(),
  }) as unknown as JobQueueRepository;
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

test('listing preserves cutoff, depth, symlink targets and stable newest-first order', async () => {
  mkdirSync(join(root, 'nested/deeper'), { recursive: true });
  const make = (name: string, seconds: number) => {
    const path = join(root, name);
    writeFileSync(path, name);
    utimesSync(path, seconds, seconds);
    return path;
  };
  const old = make('old.jsonl', 1);
  const tie = make('tie.jsonl', 2);
  const recent = make('nested/recent.jsonl', 3);
  make('nested/deeper/too-deep.jsonl', 4);
  make('ignored.txt', 5);
  symlinkSync(tie, join(root, 'alias.jsonl'));
  symlinkSync(join(root, 'missing'), join(root, 'dangling.jsonl'));
  const ties = readdirSync(root).filter((name) => ['alias.jsonl', 'tie.jsonl'].includes(name));
  const files = await listFeedFilesAsync(root, 2000, 2);
  expect(files.map(({ path }) => path)).toEqual([recent, ...ties.map((name) => join(root, name))]);
  expect(
    files.every(
      ({ size, mtime, path }) =>
        size === statSync(path).size && mtime === Math.floor(statSync(path).mtimeMs)
    )
  ).toBe(true);
  expect(files.some(({ path }) => path === old)).toBe(false);
  expect(await listFeedFilesAsync(join(root, 'absent'), 0)).toEqual([]);
});

test('vanished checks ignore adjacent roots, keep directories and follow symlinks', async () => {
  const present = join(root, 'present');
  mkdirSync(present);
  const missing = join(root, 'missing.jsonl');
  const link = join(root, 'dangling.jsonl');
  symlinkSync(missing, link);
  const paths = [present, missing, link, `${root}-adjacent/missing.jsonl`];
  const offsets = new Map(paths.map((path) => [path, { offset: 1, size: 1, mtime: 1 }]));
  expect(await vanishedFeedPaths(root, offsets)).toEqual([missing, link]);
  expect([...offsets.keys()]).toEqual(paths);
});
