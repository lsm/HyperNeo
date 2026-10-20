import { describe, expect, test } from 'bun:test';
import { createLagSamplingProfiler } from '../../../src/lib/event-loop-sampling.ts';

const frame = (name: string, line = 12) => ({
  name,
  sourceURL: '/synthetic/hot.ts?PRIVATE_PAYLOAD#secret',
  line,
  column: 9,
  privatePayload: 'NEVER_RECORD',
});
const trace = (name: string) => ({ frames: [frame(name)], timestamp: 100 });

describe('lag sampling diagnostics', () => {
  test('discards healthy-tick stacks and reports only the stalled interval', () => {
    const batches = [{ traces: [trace('old')] }, { traces: [trace('busy'), trace('busy')] }];
    const sampler = createLagSamplingProfiler(() => batches.shift()!, 0);
    expect(sampler.tick(false, 250)).toBeUndefined();
    expect(sampler.tick(true, 3000)).toEqual({
      status: 'captured',
      fromMs: 250,
      untilMs: 3000,
      sampleCount: 2,
      stacks: [{ samples: 2, frames: [{ name: 'busy', file: '/synthetic/hot.ts', line: 12 }] }],
    });
  });

  test('keeps the hottest stacks within bounded count and depth without recording payloads', () => {
    const traces = Array.from({ length: 200 }, (_, i) => ({
      frames: Array.from({ length: 30 }, () => frame(`cold${i}`)),
    }));
    traces.push(...Array.from({ length: 20 }, () => ({ frames: [frame('hottest')] })));
    const report = createLagSamplingProfiler(() => ({ traces }), 0).tick(true, 2000)!;
    expect(report.stacks).toHaveLength(5);
    expect(report.stacks![0].frames[0].name).toBe('hottest');
    expect(report.stacks!.every((stack) => stack.frames.length <= 6)).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|NEVER_RECORD|timestamp|column/);
  });

  test('drains even when rate limited and permits another report after an hour', () => {
    let drains = 0;
    const sampler = createLagSamplingProfiler(() => {
      drains++;
      return { traces: [trace(`call${drains}`)] };
    }, 0);
    for (const at of [2000, 4000, 6000]) expect(sampler.tick(true, at)?.status).toBe('captured');
    expect(sampler.tick(true, 8000)?.status).toBe('rate_limited');
    expect(sampler.tick(false, 9000)).toBeUndefined();
    expect(sampler.tick(true, 3_602_001)?.stacks![0].frames[0].name).toBe('call6');
    expect(drains).toBe(6);
  });

  test('a profiler failure is diagnostic rather than a daemon failure', () => {
    const sampler = createLagSamplingProfiler(() => {
      throw new Error('PRIVATE');
    }, 0);
    expect(sampler.tick(true, 2000)).toEqual({ status: 'failed' });
    expect(sampler.tick(true, 4000)).toEqual({ status: 'failed' });
  });
});
