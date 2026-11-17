import { describe, expect, test } from 'bun:test';
import {
  decideNeoAttention,
  NEO_ATTENTION_KINDS,
  type NeoAttentionEvent,
} from '../../../../src/lib/neo/attention/decide.ts';
import { guardDisk } from '../../../../src/lib/work-cleanup/disk-guard.ts';

const GiB = 1024 ** 3;

function disk() {
  const rows = new Map<string, number>();
  const events: NeoAttentionEvent[] = [];
  let free = 100 * GiB;
  let backstops = 0;
  const deps = {
    free: async () => free,
    gone: async () => [...rows].map(([key, goneAt]) => ({ key, goneAt })),
    mark: async (key: string, at: number) => {
      if (!rows.has(key)) rows.set(key, at);
    },
    forget: async (keys: readonly string[]) => {
      for (const key of keys) rows.delete(key);
    },
    attend: async (event: NeoAttentionEvent) => {
      events.push(event);
    },
    backstop: async () => {
      backstops += 1;
    },
  };
  return {
    deps,
    free: (gib: number) => {
      free = gib * GiB;
    },
    events,
    backstops: () => backstops,
  };
}

const action = (event: NeoAttentionEvent) =>
  decideNeoAttention(
    event,
    { covered: false, latestReportAt: null },
    event.since,
    NEO_ATTENTION_KINDS
  );

describe('guardDisk', () => {
  test('below the warning level it tells Neo in the digest and holds nothing', async () => {
    const guard = disk();
    const sweep = (gib: number, now: number) => {
      guard.free(gib);
      return guardDisk(guard.deps, now);
    };
    expect(await sweep(40, 1_000)).toEqual({ level: 'warn', hold: null });
    expect(await sweep(39, 2_000)).toEqual({ level: 'warn', hold: null });
    expect(guard.events.map(({ subject, since }) => [subject.id, since])).toEqual([
      ['warn', 1_000],
      ['warn', 1_000],
    ]);
    expect(action(guard.events[0])).toEqual({ value: { action: 'digest', step: 0 } });
    expect(guard.backstops()).toBe(0);
  });

  test('below the floor it wakes Neo, runs the backstop once and holds new starts', async () => {
    const guard = disk();
    const sweep = (gib: number, now: number) => {
      guard.free(gib);
      return guardDisk(guard.deps, now);
    };
    const below = await sweep(5, 1_000);
    expect(below.level).toBe('floor');
    expect(below.hold).toEqual(expect.any(String));
    await sweep(4, 2_000);
    expect(guard.backstops()).toBe(1);
    const floor = guard.events.filter(({ subject }) => subject.id === 'floor');
    expect(floor.map(({ since }) => since)).toEqual([1_000, 1_000]);
    expect(action(floor[0])).toEqual({ value: { action: 'wake', step: 0 } });
  });

  test('recovery above the floor releases the hold and a later drop runs the backstop again', async () => {
    const guard = disk();
    const sweep = (gib: number, now: number) => {
      guard.free(gib);
      return guardDisk(guard.deps, now);
    };
    await sweep(5, 1_000);
    expect(await sweep(20, 2_000)).toEqual({ level: 'warn', hold: null });
    expect(await sweep(80, 3_000)).toEqual({ level: 'ok', hold: null });
    const told = guard.events.length;
    await sweep(80, 4_000);
    expect(guard.events).toHaveLength(told);
    await sweep(5, 5_000);
    expect(guard.backstops()).toBe(2);
    expect(guard.events.at(-1)?.since).toBe(5_000);
  });
});
