import { describe, expect, test } from 'bun:test';
import { subscribeToStructuredLogs } from '../../../../src/lib/logger.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const options = {
  slowThresholdMs: 0,
  summaryIntervalMs: 0,
  maxQueryGroups: 20,
  summaryQueryLimit: 20,
};

function capture(run: () => void) {
  const events: { message: string; metadata: Record<string, unknown> }[] = [];
  const off = subscribeToStructuredLogs((event) => {
    if (event.module === 'hyperneo:daemon:sqlite.query') events.push(event);
  });
  try {
    run();
  } finally {
    off();
  }
  return events;
}

describe('SQLite prepare/open phase diagnostics', () => {
  test('reports phases separately without double counting execution or timing cache hits', () => {
    const events = capture(() => {
      const db = new Database(':memory:', { queryObservability: options });
      try {
        const sql = "SELECT 'private-phase-literal' AS value";
        const statement = db.prepare(sql);
        expect(db.prepare(sql)).toBe(statement);
        expect(statement.get()).toEqual({ value: 'private-phase-literal' });
      } finally {
        db.close();
      }
    });
    const phases = events.filter((event) => event.message === 'sqlite.phase.slow');
    expect(phases.map((event) => event.metadata.operation)).toEqual(['open', 'prepare']);
    expect(phases.every((event) => event.metadata.event === 'phase_slow')).toBe(true);
    expect(phases.every((event) => event.metadata.outcome === 'ok')).toBe(true);
    expect(phases.every((event) => Number(event.metadata.durationMs) >= 0)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('private-phase-literal');
    const summary = events.find((event) => event.metadata.event === 'summary');
    expect(summary?.metadata.executionCount).toBe(1);
    expect(events.filter((event) => event.metadata.event === 'slow')).toHaveLength(1);
  });

  test('keeps prepare and open errors visible without leaking a file path', () => {
    const events = capture(() => {
      const db = new Database(':memory:', { queryObservability: options });
      try {
        expect(() => db.prepare('SELECT * FROM missing_phase_table')).toThrow();
      } finally {
        db.close();
      }
      expect(
        () =>
          new Database('/nonexistent-phase-private-dir/not-a-real-db.sqlite', {
            queryObservability: options,
          })
      ).toThrow();
    });
    const failed = events.filter(
      (event) => event.message === 'sqlite.phase.slow' && event.metadata.outcome === 'error'
    );
    expect(failed.map((event) => event.metadata.operation)).toEqual(['prepare', 'open']);
    expect(JSON.stringify(events)).not.toContain('nonexistent-phase-private-dir');
    expect(JSON.stringify(events)).not.toContain('not-a-real-db.sqlite');
  });

  test('keeps unobserved connections silent', () => {
    const events = capture(() => {
      const db = new Database(':memory:');
      try {
        expect(db.prepare('SELECT 219 AS value').get()).toEqual({ value: 219 });
      } finally {
        db.close();
      }
    });
    expect(events).toEqual([]);
  });
});
