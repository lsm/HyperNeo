import { describe, expect, test } from 'bun:test';
import {
  planNeoSnapshotRead,
  rememberNeoSnapshotRead,
} from '../../../../src/lib/neo/snapshot-read.ts';
import { neoSnapshotRevision } from '../../../../src/lib/neo/operations.ts';

describe('planNeoSnapshotRead', () => {
  const full = { ok: true, rev: 'r1', scopedTo: 'ask-1' };

  test('remembers a first read and answers it in full', () => {
    expect(planNeoSnapshotRead(full, null, 0)).toEqual({
      result: full,
      remember: { rev: 'r1', compaction: 0 },
    });
  });

  test('answers unchanged when the same rev was read since the last compaction', () => {
    expect(planNeoSnapshotRead(full, { rev: 'r1', compaction: 4 }, 4)).toEqual({
      result: {
        ok: true,
        unchanged: true,
        rev: 'r1',
        note: expect.stringMatching(/held until this turn ends.*end the turn now/),
        scopedTo: 'ask-1',
      },
      remember: null,
    });
  });

  test.each([
    ['a new rev', { rev: 'r0', compaction: 4 }, 4],
    ['a compaction since the last read', { rev: 'r1', compaction: 2 }, 4],
  ])('answers in full after %s', (_label, last, compaction) => {
    expect(planNeoSnapshotRead(full, last, compaction)).toEqual({
      result: full,
      remember: { rev: 'r1', compaction },
    });
  });

  test('passes failures and explicit unchanged answers through untouched', () => {
    const failed = { ok: false };
    const unchanged = { ok: true, unchanged: true as const, rev: 'r1' };
    expect(planNeoSnapshotRead(failed, null, 0)).toEqual({ result: failed, remember: null });
    expect(planNeoSnapshotRead(unchanged, { rev: 'r1', compaction: 0 }, 0)).toEqual({
      result: unchanged,
      remember: null,
    });
  });
});

describe('rememberNeoSnapshotRead', () => {
  test('keeps the 256 most recent reads, refreshing a key it sees again', () => {
    const reads = new Map<string, { rev: string; compaction: number }>();
    for (let i = 0; i < 300; i++)
      rememberNeoSnapshotRead(reads, `k${i}`, { rev: 'r', compaction: 0 });
    rememberNeoSnapshotRead(reads, 'k100', { rev: 'r2', compaction: 0 });
    expect(reads.size).toBe(256);
    expect(reads.has('k43')).toBe(false);
    expect(reads.get('k100')).toEqual({ rev: 'r2', compaction: 0 });
    expect([...reads.keys()].at(-1)).toBe('k100');
  });
});

describe('neoSnapshotRevision', () => {
  const at = (checkedAt: number | null, label = 'Running') => ({
    ok: true,
    cards: [{ workId: 'w', label, checkedAt }],
  });

  test('a fresh check time alone keeps the rev, so a re-read still answers unchanged', () => {
    const first = neoSnapshotRevision(at(1), undefined, undefined);
    if (!('rev' in first)) throw new Error('expected a rev');
    expect(neoSnapshotRevision(at(2), first.rev, undefined)).toMatchObject({ unchanged: true });
    expect(neoSnapshotRevision(at(2, 'Needs you'), first.rev, undefined)).not.toHaveProperty(
      'unchanged'
    );
  });
});
