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
