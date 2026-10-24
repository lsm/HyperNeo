import { closeSync, openSync, readSync } from 'node:fs';
import { access, open, readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { runLagPhase } from '../event-loop-activity.ts';
import {
  dropWorkFeedSession,
  rereadWorkFeedPaths,
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
  sharesTurnsWithSiblings?: boolean;
  meta(path: string, head: string): Meta | null;
  turns(lines: readonly string[], meta: Meta): WorkFeedTurn[];
}

export interface FeedFile {
  path: string;
  size: number;
  mtime: number;
}

export async function listFeedFilesAsync(
  root: string,
  since: number,
  depth = FEED_DEPTH
): Promise<FeedFile[]> {
  const walk = async (dir: string, level: number): Promise<FeedFile[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const found = await Promise.all(
      entries.map(async (entry): Promise<FeedFile[]> => {
        const path = join(dir, entry.name);
        if (entry.isFile() && !entry.name.endsWith('.jsonl')) return [];
        const info = await stat(path).catch(() => null);
        if (info?.isDirectory()) return level < depth ? walk(path, level + 1) : [];
        return info?.isFile() && entry.name.endsWith('.jsonl') && info.mtimeMs >= since
          ? [{ path, size: info.size, mtime: Math.floor(info.mtimeMs) }]
          : [];
      })
    );
    return found.flat();
  };
  return (await walk(root, 1)).sort((a, b) => b.mtime - a.mtime);
}

export async function readFeedPrefix(path: string, bytes = HEAD_BYTES): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(bytes), 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
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

export async function vanishedFeedPaths(
  root: string,
  offsets: ReadonlyMap<string, WorkFeedOffset>,
  exists: (path: string) => Promise<boolean> = (path) =>
    access(path).then(
      () => true,
      () => false
    )
): Promise<string[]> {
  const paths = [...offsets.keys()].filter((path) => path.startsWith(`${root}${sep}`));
  const present = await Promise.all(paths.map(exists));
  return paths.filter((_path, index) => !present[index]);
}

export async function pruneVanishedFeeds<Meta extends FeedFileMeta>(
  db: BunDatabase,
  root: string,
  source: FeedSource<Meta>
): Promise<string[]> {
  const known = readWorkFeedOffsets(db);
  const gone = await vanishedFeedPaths(root, known);
  let dropped = 0;
  for (const path of gone)
    dropped += await dropWorkFeedSession(db, source.kind, source.sessionOf(path), path);
  if (!source.sharesTurnsWithSiblings || dropped === 0) return [];
  const reread = [...known.keys()].filter(
    (path) => path.startsWith(`${root}${sep}`) && !gone.includes(path)
  );
  rereadWorkFeedPaths(db, reread);
  return reread;
}

export function pendingFeedPaths(
  root: string,
  offsets: ReadonlyMap<string, WorkFeedOffset>
): string[] {
  return [...offsets].flatMap(([path, offset]) =>
    offset.size === -1 && path.startsWith(`${root}${sep}`) ? [path] : []
  );
}

export async function withKnownFeedFiles(
  listed: readonly FeedFile[],
  known: readonly string[]
): Promise<FeedFile[]> {
  const seen = new Set(listed.map((file) => file.path));
  const extra = await Promise.all(
    known
      .filter((path) => !seen.has(path))
      .map(async (path) => {
        const info = await stat(path).catch(() => null);
        return info?.isFile() ? [{ path, size: info.size, mtime: Math.floor(info.mtimeMs) }] : [];
      })
  );
  return [...listed, ...extra.flat()].sort((a, b) => b.mtime - a.mtime);
}

export function ownFeedFiles<Meta extends FeedFileMeta>(
  files: readonly FeedFile[],
  source: FeedSource<Meta>,
  own: ReadonlySet<string> | null | undefined
): FeedFile[] {
  return own ? files.filter((file) => own.has(source.sessionOf(file.path))) : [...files];
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
    const meta = runLagPhase(`feed:${source.kind}:head`, () =>
      source.meta(file.path, readFeedHead(file.path))
    );
    let from = known && known.offset <= file.size ? known.offset : 0;
    for (;;) {
      const { lines, next } = meta
        ? runLagPhase(`feed:${source.kind}:read`, () =>
            readFeedLines(file.path, from, file.size, CHUNK_BYTES)
          )
        : { lines: [], next: file.size };
      const found = meta
        ? runLagPhase(`feed:${source.kind}:parse`, () => source.turns(lines, meta))
        : [];
      runLagPhase(`feed:${source.kind}:save`, () =>
        saveWorkFeedChunk(db, source.kind, meta?.title ?? '', found, file.path, {
          offset: next,
          size: next >= file.size ? file.size : -1,
          mtime: file.mtime,
        })
      );
      turns += found.length;
      await yieldToLoop();
      if (next >= file.size || next === from || Date.now() - started >= budgetMs) break;
      from = next;
    }
    done += 1;
  }
  return { files: done, turns };
}
