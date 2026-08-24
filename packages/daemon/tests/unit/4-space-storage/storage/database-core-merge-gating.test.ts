import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type MergeStatus = 'merged' | 'failed' | 'worker-unavailable' | 'timeout' | 'cancelled';

const mergeCalls: string[] = [];
type QueuedStatus = MergeStatus | 'hang';
let statusQueue: QueuedStatus[] = [];

mock.module('../../../../src/lib/message-search-merge', () => ({
  runMessageSearchMerge: (dbPath: string) => {
    mergeCalls.push(dbPath);
    const status = statusQueue.shift() ?? 'merged';
    return {
      promise: status === 'hang' ? new Promise<MergeStatus>(() => {}) : Promise.resolve(status),
      cancel: () => {},
    };
  },
}));

const { DatabaseCore } = await import('../../../../src/storage/database-core');

const INTERVAL_MS = 20;

const shrinkInterval = (core: DatabaseCore): void => {
  (core as unknown as Record<string, unknown>).messageSearchMergeIntervalMs = INTERVAL_MS;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('DatabaseCore message search merge gating', () => {
  let testDir: string;
  let dbPath: string;
  let dbCore: DatabaseCore | null = null;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `db-core-merge-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    dbPath = join(testDir, 'test.db');
    mergeCalls.length = 0;
    statusQueue = [];
  });

  afterEach(() => {
    try {
      dbCore?.close();
    } catch {}
    dbCore = null;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('does not schedule any merge while startup has not opened the gate', async () => {
    dbCore = new DatabaseCore(dbPath);
    await dbCore.initialize();
    shrinkInterval(dbCore);

    await sleep(INTERVAL_MS * 6);

    expect(mergeCalls).toHaveLength(0);
  });

  it('runs the first merge only after startMessageSearchMerges and reschedules on completion', async () => {
    dbCore = new DatabaseCore(dbPath);
    await dbCore.initialize();
    shrinkInterval(dbCore);

    await sleep(INTERVAL_MS * 6);
    expect(mergeCalls).toHaveLength(0);

    dbCore.startMessageSearchMerges();
    await waitFor(() => mergeCalls.length >= 2);

    expect(mergeCalls[0]).toBe(dbPath);
    expect(mergeCalls[1]).toBe(dbPath);
  });

  it('ignores repeated gate opens while the merge loop is running', async () => {
    statusQueue = ['hang'];
    dbCore = new DatabaseCore(dbPath);
    await dbCore.initialize();
    shrinkInterval(dbCore);

    dbCore.startMessageSearchMerges();
    dbCore.startMessageSearchMerges();

    await waitFor(() => mergeCalls.length >= 1);
    await sleep(INTERVAL_MS * 6);

    expect(mergeCalls).toHaveLength(1);
  });

  it('keeps the worker dormant when the gate opens after close', async () => {
    dbCore = new DatabaseCore(dbPath);
    await dbCore.initialize();
    shrinkInterval(dbCore);
    dbCore.close();
    dbCore.startMessageSearchMerges();
    dbCore = null;

    await sleep(INTERVAL_MS * 6);

    expect(mergeCalls).toHaveLength(0);
  });

  it('stops rescheduling after repeated worker-unavailable failures', async () => {
    statusQueue = ['worker-unavailable', 'worker-unavailable', 'worker-unavailable'];
    dbCore = new DatabaseCore(dbPath);
    await dbCore.initialize();
    shrinkInterval(dbCore);

    dbCore.startMessageSearchMerges();
    await waitFor(() => mergeCalls.length >= 3);
    await sleep(INTERVAL_MS * 6);

    expect(mergeCalls).toHaveLength(3);
  });
});
