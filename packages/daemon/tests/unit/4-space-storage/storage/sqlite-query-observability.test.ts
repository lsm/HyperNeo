import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { subscribeToStructuredLogs } from '../../../../src/lib/logger';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSQLiteQueryDescriptor } from '../../../../src/storage/sqlite-query-normalization';
import {
  DEFAULT_SQL_QUERY_MAX_QUERY_GROUPS,
  DEFAULT_SQL_QUERY_SLOW_THRESHOLD_MS,
  DEFAULT_SQL_QUERY_SUMMARY_INTERVAL_MS,
  DEFAULT_SQL_QUERY_SUMMARY_LIMIT,
  SQLiteQueryObserver,
  type SQLiteQueryEmitParams,
  type SQLiteQueryObservabilityOptions,
} from '../../../../src/storage/sqlite-query-observability';

interface CapturedEvent {
  level: string;
  message: string;
  module?: string;
  metadata: Record<string, unknown>;
}

const OBSERVED_ALL_SLOW: SQLiteQueryObservabilityOptions = {
  slowThresholdMs: 0,
  summaryIntervalMs: 3_600_000,
  maxQueryGroups: 500,
  summaryQueryLimit: 10,
};

const OBSERVED_NONE_SLOW: SQLiteQueryObservabilityOptions = {
  slowThresholdMs: 1_000_000,
  summaryIntervalMs: 3_600_000,
  maxQueryGroups: 500,
  summaryQueryLimit: 10,
};

function captureEvents(whileRunning: (collect: CapturedEvent[]) => void): CapturedEvent[] {
  const collected: CapturedEvent[] = [];
  const unsubscribe = subscribeToStructuredLogs((event) => {
    if (event.module === 'hyperneo:daemon:sqlite.query') {
      collected.push({
        level: event.level,
        message: event.message,
        module: event.module,
        metadata: event.metadata,
      });
    }
  });
  try {
    whileRunning(collected);
  } finally {
    unsubscribe();
  }
  return collected;
}

function metadataList(events: CapturedEvent[]): Record<string, unknown>[] {
  return events.map((event) => event.metadata);
}

describe('SQLiteQueryObserver', () => {
  function createHarness(options?: Partial<SQLiteQueryObservabilityOptions>) {
    const events: SQLiteQueryEmitParams[] = [];
    let nowMs = 10_000;
    const timers: Array<{ callback: () => void; cleared: boolean }> = [];
    let observerReference: SQLiteQueryObserver | null = null;
    const observer = new SQLiteQueryObserver(
      {
        slowThresholdMs: 100,
        summaryIntervalMs: 5,
        maxQueryGroups: 2,
        summaryQueryLimit: 2,
        ...options,
      },
      {
        emitEvent: (params) => {
          events.push(params);
          if (params.metadata.event === 'slow') {
            observerReference?.recordExecution({
              descriptor: createSQLiteQueryDescriptor('SELECT reentrant_probe'),
              operation: 'get',
              durationMs: 500,
              outcome: 'ok',
            });
          }
        },
        now: () => nowMs,
        setTimer: (callback) => {
          timers.push({ callback, cleared: false });
          return timers.length - 1;
        },
        clearTimer: (handle) => {
          const timer = timers[handle as number];
          if (timer) timer.cleared = true;
        },
      }
    );
    observerReference = observer;
    return {
      observer,
      events,
      timers,
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  test('emits one slow event per execution at or above the threshold and aggregates groups', () => {
    const harness = createHarness();
    const descriptor = createSQLiteQueryDescriptor('SELECT * FROM sessions WHERE id = ?');
    harness.observer.recordExecution({
      descriptor,
      operation: 'get',
      durationMs: 40,
      outcome: 'ok',
      rowsReturned: 1,
    });
    expect(harness.events).toHaveLength(0);

    harness.observer.recordExecution({
      descriptor,
      operation: 'get',
      durationMs: 250,
      outcome: 'ok',
      rowsReturned: 1,
    });
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0].level).toBe('warn');
    expect(harness.events[0].event).toBe('sqlite.query.slow');
    expect(harness.events[0].metadata.fingerprint).toBe(descriptor.fingerprint);
    expect(harness.events[0].metadata.operation).toBe('get');
    expect(harness.events[0].metadata.rowsReturned).toBe(1);

    harness.observer.recordExecution({
      descriptor,
      operation: 'get',
      durationMs: 300,
      outcome: 'error',
    });
    expect(harness.events).toHaveLength(2);
    expect(harness.events[1].metadata.outcome).toBe('error');
    expect(harness.events[1].metadata.rowsReturned).toBeUndefined();

    harness.observer.flushSummary('interval');
    const summary = harness.events.find((event) => event.event === 'sqlite.query.summary');
    expect(summary).toBeDefined();
    const queries = summary?.metadata.queries as Array<Record<string, unknown>>;
    expect(queries).toHaveLength(1);
    expect(queries[0].executionCount).toBe(3);
    expect(queries[0].slowExecutionCount).toBe(2);
    expect(queries[0].errorCount).toBe(1);
    expect(queries[0].maxDurationMs).toBe(300);
    expect(summary?.metadata.executionCount).toBe(3);
  });

  test('emitting guards block reentrant recording', () => {
    const harness = createHarness({ slowThresholdMs: 10 });
    harness.observer.recordExecution({
      descriptor: createSQLiteQueryDescriptor('SELECT 1'),
      operation: 'get',
      durationMs: 50,
      outcome: 'ok',
    });
    const slowEvents = harness.events.filter((event) => event.event === 'sqlite.query.slow');
    expect(slowEvents).toHaveLength(1);
    expect(
      slowEvents.some((event) => event.metadata.normalizedSql === 'select reentrant_probe')
    ).toBe(false);
  });

  test('evicts the smallest-max group at capacity and counts discarded executions', () => {
    const harness = createHarness({ maxQueryGroups: 2 });
    const record = (sql: string, durationMs: number) => {
      harness.observer.recordExecution({
        descriptor: createSQLiteQueryDescriptor(sql),
        operation: 'all',
        durationMs,
        outcome: 'ok',
        rowsReturned: 0,
      });
    };
    record('SELECT slow_query_a', 500);
    record('SELECT small_query_b', 50);
    record('SELECT medium_query_c', 200);
    record('SELECT tiny_query_d', 10);

    harness.observer.flushSummary('interval');
    const summary = harness.events.find((event) => event.event === 'sqlite.query.summary');
    expect(summary?.metadata.evictedQueryGroupCount).toBe(1);
    expect(summary?.metadata.discardedExecutionCount).toBe(1);
    const queries = (summary?.metadata.queries as Array<Record<string, unknown>>).map(
      (query) => query.normalizedSql
    );
    expect(queries).toEqual(['select slow_query_a', 'select medium_query_c']);
  });

  test('sorts summary queries by max duration descending within the summary limit', () => {
    const harness = createHarness({
      maxQueryGroups: 10,
      summaryQueryLimit: 2,
      slowThresholdMs: 1000,
    });
    for (let index = 0; index < 4; index += 1) {
      harness.observer.recordExecution({
        descriptor: createSQLiteQueryDescriptor(`SELECT ordering_${index}`),
        operation: 'all',
        durationMs: 100 + index,
        outcome: 'ok',
        rowsReturned: 0,
      });
    }
    harness.observer.flushSummary('interval');
    const summary = harness.events.find((event) => event.event === 'sqlite.query.summary');
    const queries = summary?.metadata.queries as Array<Record<string, unknown>>;
    expect(queries).toHaveLength(2);
    expect(queries[0].normalizedSql).toBe('select ordering_3');
    expect(queries[1].normalizedSql).toBe('select ordering_2');
  });

  test('empty windows emit no summary and reset the window clock', () => {
    const harness = createHarness();
    harness.advance(1000);
    harness.observer.flushSummary('interval');
    expect(harness.events).toHaveLength(0);
  });

  test('close clears the timer and flushes exactly one final summary', () => {
    const harness = createHarness();
    harness.observer.recordExecution({
      descriptor: createSQLiteQueryDescriptor('SELECT 1'),
      operation: 'get',
      durationMs: 1,
      outcome: 'ok',
      rowsReturned: 1,
    });
    harness.observer.close();
    harness.observer.close();
    expect(harness.timers.every((timer) => timer.cleared)).toBe(true);
    const summaries = harness.events.filter((event) => event.event === 'sqlite.query.summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].metadata.reason).toBe('close');
    harness.observer.recordExecution({
      descriptor: createSQLiteQueryDescriptor('SELECT 2'),
      operation: 'get',
      durationMs: 1,
      outcome: 'ok',
    });
    expect(harness.events).toHaveLength(1);
  });

  test('exposes the documented production defaults', () => {
    expect(DEFAULT_SQL_QUERY_SLOW_THRESHOLD_MS).toBe(250);
    expect(DEFAULT_SQL_QUERY_SUMMARY_INTERVAL_MS).toBe(300_000);
    expect(DEFAULT_SQL_QUERY_MAX_QUERY_GROUPS).toBe(500);
    expect(DEFAULT_SQL_QUERY_SUMMARY_LIMIT).toBe(10);
  });
});

describe('sqlite query observability through the bun compat layer', () => {
  test('records get, all, and run once each with their row metrics', () => {
    const events = captureEvents((collected) => {
      const db = new Database(':memory:', { queryObservability: OBSERVED_ALL_SLOW });
      try {
        db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');
        const insert = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)');
        insert.run('a', 'one');
        insert.run('b', 'two');
        const select = db.prepare('SELECT v FROM kv WHERE k = ?');
        select.get('a');
        select.all('a');
        const byKey = metadataList(collected);
        expect(
          byKey.find((meta) => meta.operation === 'get' && meta.rowsReturned === 1)
        ).toBeDefined();
        expect(
          byKey.find((meta) => meta.operation === 'run' && meta.rowsChanged === 1)
        ).toBeDefined();
      } finally {
        db.close();
      }
    });
    const allRuns = metadataList(events).filter((meta) => meta.operation === 'run');
    expect(allRuns).toHaveLength(2);
    expect(metadataList(events).some((meta) => meta.operation === 'all')).toBe(true);
  });

  test('records iterate once on full consumption and once on early return', () => {
    const events = captureEvents((collected) => {
      const db = new Database(':memory:', { queryObservability: OBSERVED_ALL_SLOW });
      try {
        db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');
        const insert = db.prepare('INSERT INTO items (label) VALUES (?)');
        for (let index = 0; index < 4; index += 1) insert.run(`row-${index}`);
        const full = db.prepare('SELECT id FROM items ORDER BY id ASC');
        let fullRows = 0;
        for (const row of full.iterate()) {
          fullRows += 1;
          expect(row).toBeDefined();
        }
        const partial = db.prepare('SELECT id FROM items ORDER BY id ASC');
        const iterator = partial.iterate();
        iterator.next();
        iterator.next();
        iterator.return?.(undefined);
        const byOperation = metadataList(collected).filter((meta) => meta.operation === 'iterate');
        expect(byOperation).toHaveLength(2);
        expect(byOperation[0].rowsReturned).toBe(fullRows);
        expect(byOperation[1].rowsReturned).toBe(2);
      } finally {
        db.close();
      }
    });
    expect(metadataList(events).filter((meta) => meta.operation === 'iterate')).toHaveLength(2);
  });

  test('database-level query() and run() aliases record exactly one execution', () => {
    const events = captureEvents((collected) => {
      const db = new Database(':memory:', { queryObservability: OBSERVED_ALL_SLOW });
      try {
        db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');
        db.run("INSERT INTO kv (k, v) VALUES ('alias-key', 'alias-value')");
        db.query('SELECT v FROM kv').all();
        const reads = metadataList(collected).filter(
          (meta) => meta.normalizedSql === 'select v from kv'
        );
        expect(reads).toHaveLength(1);
        const inserts = metadataList(collected).filter(
          (meta) => meta.normalizedSql === 'insert into kv (k, v) values (?, ?)'
        );
        expect(inserts).toHaveLength(1);
      } finally {
        db.close();
      }
    });
    expect(events.length).toBeGreaterThan(0);
  });

  test('records exec as an opaque operation without row metrics', () => {
    const events = captureEvents((collected) => {
      const db = new Database(':memory:', { queryObservability: OBSERVED_ALL_SLOW });
      try {
        db.exec('CREATE TABLE exec_probe (x INTEGER)');
        const execEvents = metadataList(collected).filter((meta) => meta.operation === 'exec');
        expect(execEvents).toHaveLength(1);
        expect(execEvents[0].rowsReturned).toBeUndefined();
        expect(execEvents[0].rowsChanged).toBeUndefined();
      } finally {
        db.close();
      }
    });
    expect(metadataList(events).some((meta) => meta.operation === 'exec')).toBe(true);
  });

  test('observes statements inside transactions without exposing transaction controls', () => {
    const events = captureEvents((collected) => {
      const db = new Database(':memory:', { queryObservability: OBSERVED_ALL_SLOW });
      try {
        db.exec('CREATE TABLE txn (k TEXT PRIMARY KEY)');
        db.transaction(() => {
          db.prepare('INSERT INTO txn (k) VALUES (?)').run('inside');
          db.prepare('SELECT k FROM txn WHERE k = ?').get('inside');
        })();
        const normalized = metadataList(collected).map((meta) => String(meta.normalizedSql));
        expect(normalized).toContainEqual('insert into txn (k) values (?)');
        expect(normalized).toContainEqual('select k from txn where k = ?');
        expect(normalized.some((sql) => /\b(begin|commit|rollback|savepoint)\b/.test(sql))).toBe(
          false
        );
      } finally {
        db.close();
      }
    });
    expect(events.length).toBeGreaterThan(0);
  });

  test('records error outcomes and rethrows the original sqlite error', () => {
    expect(() =>
      captureEvents((collected) => {
        const db = new Database(':memory:', { queryObservability: OBSERVED_ALL_SLOW });
        try {
          db.exec('CREATE TABLE uniq (k TEXT PRIMARY KEY)');
          const insert = db.prepare('INSERT INTO uniq (k) VALUES (?)');
          insert.run('dup');
          try {
            insert.run('dup');
          } catch (error) {
            const failed = metadataList(collected).filter(
              (meta) => meta.outcome === 'error' && meta.operation === 'run'
            );
            expect(failed).toHaveLength(1);
            throw error;
          }
        } finally {
          db.close();
        }
      })
    ).toThrow();
  });

  test('never serializes bound parameters or inlined literals into events', () => {
    const events = captureEvents((collected) => {
      const db = new Database(':memory:', { queryObservability: OBSERVED_ALL_SLOW });
      try {
        db.exec('CREATE TABLE secrets (token TEXT)');
        db.exec("INSERT INTO secrets (token) VALUES ('sk-inlined-secret-value')");
        db.prepare('INSERT INTO secrets (token) VALUES (?)').run('sk-bound-secret-value');
        db.prepare('SELECT token FROM secrets WHERE token = ?').get('sk-bound-secret-value');
        expect(collected.length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('sk-inlined-secret-value');
    expect(serialized).not.toContain('sk-bound-secret-value');
  });

  test('a slow-event subscriber that queries the same database cannot recurse', () => {
    const db = new Database(':memory:', { queryObservability: OBSERVED_ALL_SLOW });
    try {
      db.exec('CREATE TABLE reentrancy (x INTEGER)');
      const probe = db.prepare('SELECT 1 AS touch');
      const seen: string[] = [];
      const unsubscribe = subscribeToStructuredLogs((event) => {
        if (event.module === 'hyperneo:daemon:sqlite.query') {
          seen.push(String(event.metadata.normalizedSql));
          probe.get();
        }
      });
      try {
        db.prepare('INSERT INTO reentrancy (x) VALUES (?)').run(1);
      } finally {
        unsubscribe();
      }
      expect(seen.some((sql) => sql === 'select ? as touch')).toBe(false);
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test('flushes a final summary on close and preserves cached statement identity', () => {
    const descriptorOfInsert = createSQLiteQueryDescriptor(
      'INSERT INTO cache_probe (x) VALUES (?)'
    );
    const events = captureEvents((collected) => {
      const db = new Database(':memory:', { queryObservability: OBSERVED_ALL_SLOW });
      try {
        db.exec('CREATE TABLE cache_probe (x INTEGER)');
        expect(db.prepare('INSERT INTO cache_probe (x) VALUES (?)')).toBe(
          db.prepare('INSERT INTO cache_probe (x) VALUES (?)')
        );
        const insert = db.prepare('INSERT INTO cache_probe (x) VALUES (?)');
        expect(typeof (insert as unknown as { run: unknown }).run).toBe('function');
        insert.run(1);
        expect(collected.some((event) => event.metadata.event === 'slow')).toBe(true);
      } finally {
        db.close();
      }
    });
    const summary = events.find((event) => event.metadata.event === 'summary');
    expect(summary).toBeDefined();
    expect(summary?.metadata.reason).toBe('close');
    const queries = summary?.metadata.queries as Array<Record<string, unknown>>;
    expect(queries.some((query) => query.fingerprint === descriptorOfInsert.fingerprint)).toBe(
      true
    );
  });

  test('stays silent when no execution crosses the threshold but still summarizes on close', () => {
    const events = captureEvents((collected) => {
      const db = new Database(':memory:', { queryObservability: OBSERVED_NONE_SLOW });
      try {
        db.exec('CREATE TABLE quiet (x INTEGER)');
        db.prepare('INSERT INTO quiet (x) VALUES (?)').run(1);
        db.prepare('SELECT x FROM quiet').all();
      } finally {
        db.close();
      }
      expect(collected.filter((event) => event.metadata.event === 'slow')).toHaveLength(0);
    });
    const summary = events.find((event) => event.metadata.event === 'summary');
    expect(summary).toBeDefined();
    expect(summary?.metadata.executionCount).toBeGreaterThan(0);
  });
});

describe('sqlite query observability through the node compat layer', () => {
  test('node:sqlite driver reports the same execution coverage', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
    const driverPath = join(
      repoRoot,
      'packages/daemon/tests/helpers/sqlite-query-observability-node-driver.ts'
    );
    const result = spawnSync('node', ['--import', 'tsx', driverPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(
        `node driver exited ${result.status}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`
      );
    }
    const checks = JSON.parse((result.stdout.trim().split('\n').pop() ?? '') as string) as Record<
      string,
      unknown
    >;
    expect(checks.nodeSqliteAvailable).toBe(true);
    expect(checks.slowCount as number).toBeGreaterThan(0);
    expect(checks.hasGet).toBe(true);
    expect(checks.hasAll).toBe(true);
    expect(checks.hasIterateWithRows).toBe(true);
    expect(checks.hasRun).toBe(true);
    expect(checks.hasExec).toBe(true);
    expect(checks.hasErrorOutcome).toBe(true);
    expect(checks.transactionControlsAbsent).toBe(true);
    expect(checks.summaryEmitted).toBe(true);
    expect(checks.secretAbsent).toBe(true);
  });
});
