import { closeSync, openSync, readSync, statSync } from 'node:fs';

export const CLONE_SETTLE_MIN_BYTES = 1024 ** 3;
export const CLONE_SETTLE_SLOW_READ_MS = 1_000;
export const CLONE_SETTLE_NO_BLOCK_WINDOW_MS = 45_000;
export const CLONE_SETTLE_MAX_WAIT_MS = 5 * 60_000;
const CLONE_SETTLE_PROBE_INTERVAL_MS = 200;
const PAGE_BYTES = 4096;

export type CloneSettleVerdict = 'probe' | 'settled' | 'no-block' | 'gave-up';

export interface CloneSettleProgress {
  sinceCloneMs: number;
  blockSeen: boolean;
  lastReadMs: number;
}

export function cloneSettleVerdict(progress: CloneSettleProgress): CloneSettleVerdict {
  if (progress.blockSeen && progress.lastReadMs < CLONE_SETTLE_SLOW_READ_MS) return 'settled';
  if (progress.sinceCloneMs >= CLONE_SETTLE_MAX_WAIT_MS) return 'gave-up';
  if (!progress.blockSeen && progress.sinceCloneMs >= CLONE_SETTLE_NO_BLOCK_WINDOW_MS) {
    return 'no-block';
  }
  return 'probe';
}

export function shouldAwaitCloneSettle(platform: string, sizeBytes: number): boolean {
  return platform === 'darwin' && sizeBytes >= CLONE_SETTLE_MIN_BYTES;
}

export interface CloneSettleDeps {
  now: () => number;
  sleep: (ms: number) => void;
  readPage: (pageIndex: number) => void;
  pageCount: number;
  random: () => number;
}

export interface CloneSettleResult {
  verdict: Exclude<CloneSettleVerdict, 'probe'>;
  waitedMs: number;
  longestReadMs: number;
}

export function awaitCloneSettle(deps: CloneSettleDeps): CloneSettleResult {
  const startedAt = deps.now();
  let blockSeen = false;
  let longestReadMs = 0;
  for (;;) {
    const readStartedAt = deps.now();
    deps.readPage(Math.floor(deps.random() * deps.pageCount));
    const lastReadMs = deps.now() - readStartedAt;
    longestReadMs = Math.max(longestReadMs, lastReadMs);
    const blocked = lastReadMs >= CLONE_SETTLE_SLOW_READ_MS;
    const verdict = cloneSettleVerdict({
      sinceCloneMs: deps.now() - startedAt,
      blockSeen: blockSeen || blocked,
      lastReadMs,
    });
    if (verdict !== 'probe') {
      return { verdict, waitedMs: deps.now() - startedAt, longestReadMs };
    }
    if (blocked) blockSeen = true;
    else deps.sleep(CLONE_SETTLE_PROBE_INTERVAL_MS);
  }
}

export function awaitFileCloneSettle(path: string): CloneSettleResult | null {
  const sizeBytes = statSync(path).size;
  if (!shouldAwaitCloneSettle(process.platform, sizeBytes)) return null;
  const fd = openSync(path, 'r');
  const page = Buffer.alloc(PAGE_BYTES);
  const sleepCell = new Int32Array(new SharedArrayBuffer(4));
  try {
    return awaitCloneSettle({
      now: Date.now,
      sleep: (ms) => {
        Atomics.wait(sleepCell, 0, 0, ms);
      },
      readPage: (pageIndex) => {
        readSync(fd, page, 0, PAGE_BYTES, pageIndex * PAGE_BYTES);
      },
      pageCount: Math.max(1, Math.floor(sizeBytes / PAGE_BYTES)),
      random: Math.random,
    });
  } finally {
    closeSync(fd);
  }
}
