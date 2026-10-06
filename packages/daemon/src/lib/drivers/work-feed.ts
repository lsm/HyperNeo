import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import {
  dropWorkFeedSession,
  readWorkFeedOffsets,
  saveWorkFeedChunk,
  type WorkFeedKind,
  type WorkFeedOffset,
  type WorkFeedTurn,
} from '../../storage/work-feed.ts';

const FEED_DEPTH = 4;
const HEAD_BYTES = 256 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
const FEED_BUDGET_MS = 10_000;

export interface FeedFileMeta {
  sessionId: string;
  title: string;
}

export interface FeedSource<Meta extends FeedFileMeta> {
  kind: WorkFeedKind;
  sessionOf(path: string): string;
  meta(path: string, head: string): Meta | null;
  turns(lines: readonly string[], meta: Meta): WorkFeedTurn[];
}

export interface FeedFile {
  path: string;
  size: number;
  mtime: number;
}

export function listFeedFiles(root: string, since: number): FeedFile[] {
  const files: FeedFile[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < FEED_DEPTH) walk(path, depth + 1);
      } else if (name.endsWith('.jsonl') && stat.mtimeMs >= since) {
        files.push({ path, size: stat.size, mtime: Math.floor(stat.mtimeMs) });
      }
    }
  };
  walk(root, 1);
  return files.sort((a, b) => b.mtime - a.mtime);
}

export function changedFeedFiles(
  files: readonly FeedFile[],
  offsets: ReadonlyMap<string, WorkFeedOffset>
): FeedFile[] {
  return files.filter((file) => {
    const known = offsets.get(file.path);
    return !known || known.size !== file.size || known.offset > file.size;
  });
}

function readBytes(path: string, offset: number, length: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

export function readFeedLines(
  path: string,
  offset: number,
  size: number,
  maxBytes: number
): { lines: string[]; next: number } {
  const chunk = readBytes(path, offset, Math.min(maxBytes, Math.max(0, size - offset)));
  const end = chunk.lastIndexOf(0x0a);
  if (end < 0)
    return { lines: [], next: chunk.length >= maxBytes ? offset + chunk.length : offset };
  return {
    lines: chunk.subarray(0, end).toString('utf8').split('\n'),
    next: offset + end + 1,
  };
}

export function readFeedHead(path: string): string {
  return readBytes(path, 0, HEAD_BYTES).toString('utf8');
}

export function vanishedFeedPaths(
  root: string,
  offsets: ReadonlyMap<string, WorkFeedOffset>,
  exists: (path: string) => boolean = existsSync
): string[] {
  return [...offsets.keys()].filter((path) => path.startsWith(`${root}${sep}`) && !exists(path));
}

export function pruneVanishedFeeds<Meta extends FeedFileMeta>(
  db: BunDatabase,
  root: string,
  source: FeedSource<Meta>
): number {
  const gone = vanishedFeedPaths(root, readWorkFeedOffsets(db));
  for (const path of gone) dropWorkFeedSession(db, source.kind, source.sessionOf(path), path);
  return gone.length;
}

const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function feedWorkFiles<Meta extends FeedFileMeta>(
  db: BunDatabase,
  files: readonly FeedFile[],
  source: FeedSource<Meta>,
  budgetMs = FEED_BUDGET_MS
): Promise<{ files: number; turns: number }> {
  const started = Date.now();
  const offsets = readWorkFeedOffsets(db);
  let done = 0;
  let turns = 0;
  for (const file of files) {
    if (Date.now() - started >= budgetMs) break;
    const known = offsets.get(file.path);
    const meta = source.meta(file.path, readFeedHead(file.path));
    let from = known && known.offset <= file.size ? known.offset : 0;
    for (;;) {
      const { lines, next } = meta
        ? readFeedLines(file.path, from, file.size, CHUNK_BYTES)
        : { lines: [], next: file.size };
      const found = meta ? source.turns(lines, meta) : [];
      saveWorkFeedChunk(db, source.kind, meta?.title ?? '', found, file.path, {
        offset: next,
        size: next >= file.size ? file.size : -1,
        mtime: file.mtime,
      });
      turns += found.length;
      await yieldToLoop();
      if (next >= file.size || next === from || Date.now() - started >= budgetMs) break;
      from = next;
    }
    done += 1;
  }
  return { files: done, turns };
}
