import { describe, expect, test } from 'bun:test';
import { EventLoopActivity, beginLagPhase } from '../../../src/lib/event-loop-activity';

describe('Event-loop diagnostic activity', () => {
  test('reports only phases from the delayed tick and bounds retained names', () => {
    let now = 0;
    const activity = new EventLoopActivity(() => now);
    activity.record('stale.rpc');
    expect(activity.drain().entries).toHaveLength(1);
    now = 1500;
    for (let i = 0; i < 70; i++) activity.record(`job.${i}`);
    const report = activity.drain();
    expect(report.entries).toHaveLength(64);
    expect(report.dropped).toBe(6);
    expect(report.entries[0].name).toBe('job.6');
    expect(report.entries.at(-1)?.name).toBe('job.69');
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
