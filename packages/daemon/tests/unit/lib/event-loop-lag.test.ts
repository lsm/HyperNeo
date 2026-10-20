import { describe, expect, test } from 'bun:test';
import { startEventLoopLagLog } from '../../../src/lib/event-loop-lag';
import {
  SQLiteQueryObserver,
  takeSlowestQuery,
} from '../../../src/storage/sqlite-query-observability';

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('startEventLoopLagLog', () => {
  test('warns once per blocked tick with the slowest SQL seen while blocked, and stays quiet otherwise', async () => {
    const clock = [0, 10, 1_510, 1_520];
    const lines: string[] = [];
    const stop = startEventLoopLagLog((line) => lines.push(line), {
      now: () => clock.shift() ?? 1_520,
      tickMs: 10,
      takeSlowest: () => ({ durationMs: 1_234.5, sql: 'select count (*) from sdk_messages' }),
    });
    await settle();
    stop();
    expect(lines).toEqual([
      '[Daemon] Event loop blocked for 1490ms; slowest SQL 1235ms: select count (*) from sdk_messages',
    ]);
  });
});

describe('startEventLoopLagLog startup', () => {
  test('does not blame a block on SQL that ran before the log started', async () => {
    const clock = [0, 1_510, 1_520];
    const slow = [
      { durationMs: 1_835, sql: 'update neo_publications set payload_json = replace (…)' },
    ];
    const lines: string[] = [];
    const stop = startEventLoopLagLog((line) => lines.push(line), {
      now: () => clock.shift() ?? 1_520,
      tickMs: 10,
      takeSlowest: () => slow.shift() ?? null,
    });
    await settle();
    stop();
    expect(lines).toEqual(['[Daemon] Event loop blocked for 1500ms']);
  });
});

describe('takeSlowestQuery', () => {
  test('returns the slowest statement over the slow threshold once, then forgets it', () => {
    const observer = new SQLiteQueryObserver(
      { slowThresholdMs: 100, summaryIntervalMs: 0, maxQueryGroups: 10, summaryQueryLimit: 5 },
      { emitEvent: () => {} }
    );
    takeSlowestQuery();
    const run = (sql: string, durationMs: number) =>
      observer.recordExecution({
        descriptor: { fingerprint: sql, normalizedSql: sql, normalizedSqlTruncated: false },
        operation: 'get',
        durationMs,
        outcome: 'ok',
      } as Parameters<SQLiteQueryObserver['recordExecution']>[0]);
    run('fast', 50);
    run('slow', 300);
    run('slower', 900);
    run('slow again', 400);
    expect(takeSlowestQuery()).toEqual({ durationMs: 900, sql: 'slower' });
    expect(takeSlowestQuery()).toBeNull();
  });
});

describe('Event-loop lag diagnostic report', () => {
  test('keeps the lag line stable while reporting before/after heap and phase names', async () => {
    const diagnostics: Record<string, unknown>[] = [];
    const clock = [0, 10, 1510, 1520];
    const heaps = [900_000_000, 910_000_000, 100_000_000, 101_000_000];
    const lines: string[] = [];
    const stop = startEventLoopLagLog((line) => lines.push(line), {
      now: () => clock.shift() ?? 1520,
      tickMs: 10,
      takeSlowest: () => null,
      sampleHeap: () => heaps.shift() ?? 101_000_000,
      onDiagnostic: (report) => diagnostics.push(report),
    });
    await settle();
    stop();
    expect(lines).toEqual(['[Daemon] Event loop blocked for 1490ms']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      lagMs: 1490,
      heapBeforeBytes: 910_000_000,
      heapAfterBytes: 100_000_000,
      heapDeltaBytes: -810_000_000,
      activities: [],
    });
  });
});

describe('Event-loop lag resource breakdown', () => {
  test('a blocked tick reports its own CPU, off-CPU time, page faults, block writes and context switches', async () => {
    const diagnostics: Record<string, unknown>[] = [];
    const clock = [0, 10, 1510, 1520];
    const samples = [
      {
        cpuMs: 0,
        cpuSampler: 'thread' as const,
        majorFaults: 0,
        blockWrites: 0,
        voluntarySwitches: 0,
      },
      {
        cpuMs: 4,
        cpuSampler: 'thread' as const,
        majorFaults: 1,
        blockWrites: 0,
        voluntarySwitches: 1,
      },
      {
        cpuMs: 44,
        cpuSampler: 'thread' as const,
        majorFaults: 901,
        blockWrites: 3,
        voluntarySwitches: 3,
      },
    ];
    const stop = startEventLoopLagLog(() => {}, {
      now: () => clock.shift() ?? 1520,
      tickMs: 10,
      takeSlowest: () => null,
      sampleResources: () =>
        samples.shift() ?? {
          cpuMs: 44,
          cpuSampler: 'thread' as const,
          majorFaults: 901,
          blockWrites: 3,
          voluntarySwitches: 3,
        },
      onDiagnostic: (report) => diagnostics.push(report),
    });
    await settle();
    stop();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      lagMs: 1490,
      resources: {
        cpuSampler: 'thread',
        threadCpuMs: 40,
        offCpuMs: 1460,
        majorPageFaults: 900,
        blockWrites: 3,
        voluntaryContextSwitches: 2,
      },
    });
  });
});

describe('Event-loop heap sampler budget', () => {
  test('uses block-only sampling after a sample exceeds one millisecond', async () => {
    const clock = [0, 10, 1510, 1520];
    let samples = 0;
    const diagnostics: Record<string, unknown>[] = [];
    const stop = startEventLoopLagLog(() => {}, {
      now: () => clock.shift() ?? 1520,
      tickMs: 10,
      takeSlowest: () => null,
      sampleHeap: () => {
        samples++;
        const until = performance.now() + 3;
        while (performance.now() < until) {}
        return 100;
      },
      onDiagnostic: (report) => diagnostics.push(report),
    });
    await settle();
    stop();
    expect(samples).toBe(2);
    expect(diagnostics[0]).toMatchObject({ heapSampling: 'blocks_only', heapBeforeAgeMs: 1510 });
  });
});

describe('stalled-tick sampling output', () => {
  test('drains on healthy ticks and includes profiler results only in lag metadata', async () => {
    const clock = [0, 10, 1510, 1520];
    const calls: boolean[] = [];
    const reports: Record<string, unknown>[] = [];
    const lines: string[] = [];
    const stop = startEventLoopLagLog((line) => lines.push(line), {
      now: () => clock.shift() ?? 1520,
      tickMs: 10,
      takeSlowest: () => null,
      sampleStacks: (blocked) => {
        calls.push(blocked);
        return blocked ? { status: 'captured', stacks: [] } : undefined;
      },
      onDiagnostic: (report) => reports.push(report),
    });
    await settle();
    stop();
    expect(calls.slice(0, 3)).toEqual([false, true, false]);
    expect(reports).toHaveLength(1);
    expect(reports[0].samplingProfile).toEqual({ status: 'captured', stacks: [] });
    expect(lines).toEqual(['[Daemon] Event loop blocked for 1490ms']);
  });
});
