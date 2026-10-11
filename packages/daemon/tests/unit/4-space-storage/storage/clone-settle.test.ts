import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLONE_SETTLE_MAX_WAIT_MS,
  CLONE_SETTLE_MIN_BYTES,
  CLONE_SETTLE_NO_BLOCK_WINDOW_MS,
  awaitCloneSettle,
  awaitFileCloneSettle,
  cloneSettleVerdict,
  shouldAwaitCloneSettle,
} from '../../../../src/storage/clone-settle';

function fakeDisk(readDurations: (callIndex: number, now: number) => number) {
  let now = 0;
  let calls = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    calls: () => calls,
    deps: {
      now: () => now,
      sleep: (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
      readPage: () => {
        now += readDurations(calls, now);
        calls++;
      },
      pageCount: 10,
      random: () => 0.5,
    },
  };
}

describe('cloneSettleVerdict', () => {
  it('settles on the first fast read after a blocked read', () => {
    expect(cloneSettleVerdict({ sinceCloneMs: 80_000, blockSeen: true, lastReadMs: 2 })).toBe(
      'settled'
    );
  });

  it('keeps probing while no block has shown up inside the window', () => {
    expect(cloneSettleVerdict({ sinceCloneMs: 10_000, blockSeen: false, lastReadMs: 2 })).toBe(
      'probe'
    );
  });

  it('stops waiting when no block shows up inside the window', () => {
    expect(
      cloneSettleVerdict({
        sinceCloneMs: CLONE_SETTLE_NO_BLOCK_WINDOW_MS,
        blockSeen: false,
        lastReadMs: 2,
      })
    ).toBe('no-block');
  });

  it('gives up at the overall cap', () => {
    expect(
      cloneSettleVerdict({
        sinceCloneMs: CLONE_SETTLE_MAX_WAIT_MS,
        blockSeen: true,
        lastReadMs: 5_000,
      })
    ).toBe('gave-up');
  });
});

describe('shouldAwaitCloneSettle', () => {
  it('waits only for large databases on macOS', () => {
    expect(shouldAwaitCloneSettle('darwin', CLONE_SETTLE_MIN_BYTES)).toBe(true);
    expect(shouldAwaitCloneSettle('darwin', CLONE_SETTLE_MIN_BYTES - 1)).toBe(false);
    expect(shouldAwaitCloneSettle('linux', CLONE_SETTLE_MIN_BYTES * 40)).toBe(false);
  });
});

describe('awaitCloneSettle', () => {
  it('waits through the clone block and returns once reads are fast again', () => {
    const disk = fakeDisk((call) => (call === 50 ? 68_000 : 1));
    const result = awaitCloneSettle(disk.deps);

    expect(result.verdict).toBe('settled');
    expect(result.longestReadMs).toBe(68_000);
    expect(disk.calls()).toBe(52);
  });

  it('returns after the window when the clone never blocks reads', () => {
    const disk = fakeDisk(() => 1);
    const result = awaitCloneSettle(disk.deps);

    expect(result.verdict).toBe('no-block');
    expect(result.waitedMs).toBeGreaterThanOrEqual(CLONE_SETTLE_NO_BLOCK_WINDOW_MS);
    expect(result.waitedMs).toBeLessThan(CLONE_SETTLE_NO_BLOCK_WINDOW_MS + 1_000);
  });

  it('gives up when reads stay blocked past the cap', () => {
    const disk = fakeDisk(() => 60_000);
    const result = awaitCloneSettle(disk.deps);

    expect(result.verdict).toBe('gave-up');
    expect(disk.sleeps).toEqual([]);
  });
});

describe('awaitFileCloneSettle', () => {
  it('skips small databases without probing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clone-settle-'));
    try {
      const path = join(dir, 'small.db');
      writeFileSync(path, Buffer.alloc(8192));
      expect(awaitFileCloneSettle(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
