import { describe, expect, test } from 'bun:test';
import {
  EventLoopActivity,
  beginLagPhase,
  runLagPhase,
} from '../../../src/lib/event-loop-activity';

describe('Event-loop diagnostic activity', () => {
  test('reports only phases from the delayed tick and bounds retained names', () => {
    let now = 0;
    const activity = new EventLoopActivity(() => now);
    activity.record('stale.rpc');
    expect(activity.drain().entries).toHaveLength(1);
    now = 1500;
    for (let i = 0; i < 518; i++) activity.record(`job.${i}`);
    const report = activity.drain();
    expect(report.entries).toHaveLength(512);
    expect(report.dropped).toBe(6);
    expect(report.entries[0].name).toBe('job.6');
    expect(report.entries.at(-1)?.name).toBe('job.517');
    expect(activity.drain()).toEqual({ entries: [], dropped: 0 });
  });

  test('phase completion records elapsed time even after an earlier tick drained its start', () => {
    let now = 0;
    const activity = new EventLoopActivity(() => now);
    const stop = activity.activate();
    const end = beginLagPhase('timer.stranded_delivery');
    activity.drain();
    now = 1800;
    end();
    expect(activity.drain().entries).toEqual([
      { name: 'timer.stranded_delivery', kind: 'end', atMs: 1800, durationMs: 1800 },
    ]);
    stop();
    beginLagPhase('after.stop')();
    expect(activity.drain().entries).toEqual([]);
  });
});

describe('runLagPhase', () => {
  test('preserves return values, thrown errors and the original promise', async () => {
    let now = 0;
    const activity = new EventLoopActivity(() => now);
    const stop = activity.activate();
    const value = {};
    expect(runLagPhase('sync', () => value)).toBe(value);
    const failure = new Error('unchanged');
    expect(() =>
      runLagPhase('failure', () => {
        throw failure;
      })
    ).toThrow(failure);
    const promise = Promise.resolve(value);
    expect(runLagPhase('async', () => promise)).toBe(promise);
    now = 40;
    await promise;
    expect(
      activity
        .drain()
        .entries.filter((e) => e.kind === 'end')
        .map((e) => e.name)
    ).toEqual(['sync', 'failure', 'async']);
    const pendingEnd = beginLagPhase('pending');
    stop();
    pendingEnd();
    expect(activity.drain().entries).toEqual([]);
  });
});

describe('EventLoopActivity GC records', () => {
  test('keeps overlapping GC timing but discards late GC records from an earlier tick', () => {
    const activity = new EventLoopActivity(() => 2000);
    activity.gc({ startTime: 0, duration: 100, detail: { kind: 4 } });
    activity.gc({ startTime: 1000, duration: 1500, detail: { kind: 4 } });
    expect(activity.drain(1500).entries).toEqual([
      { name: 'gc', kind: 'gc', atMs: 1000, durationMs: 1500, gcKind: 4 },
    ]);
  });
});
