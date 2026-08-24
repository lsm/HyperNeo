import { emitStructuredLogEvent } from '../lib/logger';
import {
  createSQLiteQueryDescriptor,
  type SQLiteQueryDescriptor,
} from './sqlite-query-normalization';

export type SQLiteQueryOperation = 'get' | 'all' | 'run' | 'iterate' | 'exec';

export interface SQLiteQueryObservabilityOptions {
  slowThresholdMs: number;
  summaryIntervalMs: number;
  maxQueryGroups: number;
  summaryQueryLimit: number;
}

export const DEFAULT_SQL_QUERY_SLOW_THRESHOLD_MS = 250;
export const DEFAULT_SQL_QUERY_SUMMARY_INTERVAL_MS = 300_000;
export const DEFAULT_SQL_QUERY_MAX_QUERY_GROUPS = 500;
export const DEFAULT_SQL_QUERY_SUMMARY_LIMIT = 10;

const OBSERVER_MODULE = 'hyperneo:daemon:sqlite.query';
const SLOW_QUERY_EVENT = 'sqlite.query.slow';
const SUMMARY_EVENT = 'sqlite.query.summary';

export interface SQLiteQueryExecution {
  descriptor: SQLiteQueryDescriptor;
  operation: SQLiteQueryOperation;
  durationMs: number;
  outcome: 'ok' | 'error';
  rowsReturned?: number;
  rowsChanged?: number;
}

export interface SQLiteQuerySummaryEntry {
  fingerprint: string;
  normalizedSql: string;
  normalizedSqlTruncated: boolean;
  executionCount: number;
  slowExecutionCount: number;
  errorCount: number;
  totalDurationMs: number;
  averageDurationMs: number;
  maxDurationMs: number;
  rowsReturned?: number;
  rowsChanged?: number;
  operationCounts: Record<SQLiteQueryOperation, number>;
}

interface QueryGroupAggregate {
  descriptor: SQLiteQueryDescriptor;
  executionCount: number;
  slowExecutionCount: number;
  errorCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  rowsReturnedTotal: number | undefined;
  rowsChangedTotal: number | undefined;
  operationCounts: Record<SQLiteQueryOperation, number>;
}

export interface SQLiteQuerySummaryEventMetadata {
  [key: string]: unknown;
  schemaVersion: 1;
  event: 'summary';
  reason: 'interval' | 'close';
  windowStartedAt: number;
  windowEndedAt: number;
  windowDurationMs: number;
  thresholdMs: number;
  executionCount: number;
  slowExecutionCount: number;
  errorCount: number;
  trackedQueryCount: number;
  evictedQueryGroupCount: number;
  discardedExecutionCount: number;
  queries: SQLiteQuerySummaryEntry[];
}

export interface SQLiteQueryEmitParams {
  level: 'warn' | 'info';
  event: string;
  metadata: Record<string, unknown>;
}

export interface SQLiteQueryObservabilityDeps {
  emitEvent?: (params: SQLiteQueryEmitParams) => void;
  now?: () => number;
  setTimer?: (callback: () => void, intervalMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function emptyOperationCounts(): Record<SQLiteQueryOperation, number> {
  return { get: 0, all: 0, run: 0, iterate: 0, exec: 0 };
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export class SQLiteQueryObserver {
  private readonly emitEvent: (params: SQLiteQueryEmitParams) => void;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, intervalMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly groups = new Map<string, QueryGroupAggregate>();
  private executionCount = 0;
  private slowExecutionCount = 0;
  private errorCount = 0;
  private evictedQueryGroupCount = 0;
  private discardedExecutionCount = 0;
  private windowStartedAt: number;
  private timerHandle: unknown = null;
  private emitting = false;
  private closed = false;

  constructor(
    private readonly options: SQLiteQueryObservabilityOptions,
    deps: SQLiteQueryObservabilityDeps = {}
  ) {
    this.emitEvent =
      deps.emitEvent ??
      ((params) => {
        emitStructuredLogEvent({
          level: params.level,
          args: [params.event],
          source: 'logger',
          module: OBSERVER_MODULE,
          metadata: params.metadata,
        });
      });
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.clearTimer =
      deps.clearTimer ?? ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]));
    this.windowStartedAt = this.now();
    if (this.options.summaryIntervalMs > 0) {
      this.timerHandle = this.setTimer(
        () => this.flushSummary('interval'),
        this.options.summaryIntervalMs
      );
      (this.timerHandle as { unref?: () => void } | null)?.unref?.();
    }
  }

  isRecordingEnabled(): boolean {
    return !this.closed && !this.emitting;
  }

  recordExecution(execution: SQLiteQueryExecution): void {
    if (!this.isRecordingEnabled()) return;

    const durationMs = Math.max(0, execution.durationMs);
    this.executionCount += 1;
    if (execution.outcome === 'error') this.errorCount += 1;

    if (durationMs >= this.options.slowThresholdMs) {
      this.slowExecutionCount += 1;
      this.emitSlowQueryEvent(execution, durationMs);
    }

    let group = this.groups.get(execution.descriptor.fingerprint);
    if (!group) {
      if (this.groups.size >= this.options.maxQueryGroups) {
        const evictable = this.findEvictableGroup();
        if (!evictable || evictable.maxDurationMs >= durationMs) {
          this.discardedExecutionCount += 1;
          return;
        }
        this.groups.delete(evictable.descriptor.fingerprint);
        this.evictedQueryGroupCount += 1;
      }
      group = {
        descriptor: execution.descriptor,
        executionCount: 0,
        slowExecutionCount: 0,
        errorCount: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        rowsReturnedTotal: undefined,
        rowsChangedTotal: undefined,
        operationCounts: emptyOperationCounts(),
      };
      this.groups.set(execution.descriptor.fingerprint, group);
    }

    group.executionCount += 1;
    group.totalDurationMs += durationMs;
    if (durationMs > group.maxDurationMs) group.maxDurationMs = durationMs;
    if (durationMs >= this.options.slowThresholdMs) group.slowExecutionCount += 1;
    if (execution.outcome === 'error') group.errorCount += 1;
    if (execution.rowsReturned !== undefined) {
      group.rowsReturnedTotal = (group.rowsReturnedTotal ?? 0) + execution.rowsReturned;
    }
    if (execution.rowsChanged !== undefined) {
      group.rowsChangedTotal = (group.rowsChangedTotal ?? 0) + execution.rowsChanged;
    }
    group.operationCounts[execution.operation] += 1;
  }

  flushSummary(reason: 'interval' | 'close'): void {
    const windowEndedAt = this.now();
    const windowDurationMs = Math.max(0, windowEndedAt - this.windowStartedAt);

    if (
      this.executionCount === 0 &&
      this.discardedExecutionCount === 0 &&
      this.evictedQueryGroupCount === 0
    ) {
      this.windowStartedAt = windowEndedAt;
      return;
    }

    const queries = [...this.groups.values()]
      .sort(
        (a, b) =>
          b.maxDurationMs - a.maxDurationMs ||
          b.totalDurationMs - a.totalDurationMs ||
          (a.descriptor.fingerprint < b.descriptor.fingerprint ? -1 : 1)
      )
      .slice(0, this.options.summaryQueryLimit)
      .map((group) => ({
        fingerprint: group.descriptor.fingerprint,
        normalizedSql: group.descriptor.normalizedSql,
        normalizedSqlTruncated: group.descriptor.normalizedSqlTruncated,
        executionCount: group.executionCount,
        slowExecutionCount: group.slowExecutionCount,
        errorCount: group.errorCount,
        totalDurationMs: roundMs(group.totalDurationMs),
        averageDurationMs: roundMs(group.totalDurationMs / group.executionCount),
        maxDurationMs: roundMs(group.maxDurationMs),
        ...(group.rowsReturnedTotal !== undefined ? { rowsReturned: group.rowsReturnedTotal } : {}),
        ...(group.rowsChangedTotal !== undefined ? { rowsChanged: group.rowsChangedTotal } : {}),
        operationCounts: { ...group.operationCounts },
      }));

    const metadata: SQLiteQuerySummaryEventMetadata = {
      schemaVersion: 1,
      event: 'summary',
      reason,
      windowStartedAt: this.windowStartedAt,
      windowEndedAt,
      windowDurationMs,
      thresholdMs: this.options.slowThresholdMs,
      executionCount: this.executionCount,
      slowExecutionCount: this.slowExecutionCount,
      errorCount: this.errorCount,
      trackedQueryCount: this.groups.size,
      evictedQueryGroupCount: this.evictedQueryGroupCount,
      discardedExecutionCount: this.discardedExecutionCount,
      queries,
    };

    this.emitting = true;
    try {
      this.emitEvent({ level: 'info', event: SUMMARY_EVENT, metadata });
    } catch {
    } finally {
      this.emitting = false;
    }

    this.groups.clear();
    this.executionCount = 0;
    this.slowExecutionCount = 0;
    this.errorCount = 0;
    this.evictedQueryGroupCount = 0;
    this.discardedExecutionCount = 0;
    this.windowStartedAt = windowEndedAt;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timerHandle !== null) {
      this.clearTimer(this.timerHandle);
      this.timerHandle = null;
    }
    this.flushSummary('close');
  }

  private findEvictableGroup(): QueryGroupAggregate | null {
    let smallest: QueryGroupAggregate | null = null;
    for (const group of this.groups.values()) {
      if (!smallest || group.maxDurationMs < smallest.maxDurationMs) smallest = group;
    }
    return smallest;
  }

  private emitSlowQueryEvent(execution: SQLiteQueryExecution, durationMs: number): void {
    const metadata: Record<string, unknown> = {
      schemaVersion: 1,
      event: 'slow',
      fingerprint: execution.descriptor.fingerprint,
      normalizedSql: execution.descriptor.normalizedSql,
      normalizedSqlTruncated: execution.descriptor.normalizedSqlTruncated,
      operation: execution.operation,
      durationMs: roundMs(durationMs),
      thresholdMs: this.options.slowThresholdMs,
      outcome: execution.outcome,
    };
    if (execution.rowsReturned !== undefined) metadata.rowsReturned = execution.rowsReturned;
    if (execution.rowsChanged !== undefined) metadata.rowsChanged = execution.rowsChanged;

    this.emitting = true;
    try {
      this.emitEvent({ level: 'warn', event: SLOW_QUERY_EVENT, metadata });
    } catch {
    } finally {
      this.emitting = false;
    }
  }
}

export function observeStatementExecution<T>(
  observer: SQLiteQueryObserver,
  descriptor: SQLiteQueryDescriptor,
  operation: 'get' | 'all' | 'run',
  invoke: () => T
): T {
  const start = performance.now();
  try {
    const result = invoke();
    observer.recordExecution({
      descriptor,
      operation,
      durationMs: performance.now() - start,
      outcome: 'ok',
      ...(operation === 'get'
        ? { rowsReturned: result === null || result === undefined ? 0 : 1 }
        : operation === 'all'
          ? { rowsReturned: Array.isArray(result) ? result.length : 0 }
          : {
              rowsChanged:
                typeof result === 'object' && result !== null && 'changes' in result
                  ? Number((result as { changes: number }).changes) || 0
                  : 0,
            }),
    });
    return result;
  } catch (error) {
    observer.recordExecution({
      descriptor,
      operation,
      durationMs: performance.now() - start,
      outcome: 'error',
    });
    throw error;
  }
}

export function observeIterateExecution<T>(
  invoke: () => IterableIterator<T>,
  observer: SQLiteQueryObserver,
  descriptor: SQLiteQueryDescriptor
): IterableIterator<T> {
  let activeDurationMs = 0;
  let rowsReturned = 0;
  let finished = false;
  let source: IterableIterator<T>;

  const creationStart = performance.now();
  try {
    source = invoke();
  } catch (error) {
    observer.recordExecution({
      descriptor,
      operation: 'iterate',
      durationMs: performance.now() - creationStart,
      outcome: 'error',
    });
    throw error;
  }
  activeDurationMs += performance.now() - creationStart;

  const record = (outcome: 'ok' | 'error'): void => {
    if (finished) return;
    finished = true;
    observer.recordExecution({
      descriptor,
      operation: 'iterate',
      durationMs: activeDurationMs,
      outcome,
      rowsReturned,
    });
  };

  const timed = <R>(call: () => R): R => {
    const start = performance.now();
    try {
      return call();
    } finally {
      activeDurationMs += performance.now() - start;
    }
  };

  const wrapper: IterableIterator<T> = {
    next(): IteratorResult<T> {
      if (finished) return { done: true, value: undefined as T };
      try {
        const result = timed(() => source.next());
        if (result.done) {
          record('ok');
        } else {
          rowsReturned += 1;
        }
        return result;
      } catch (error) {
        record('error');
        throw error;
      }
    },
    return(value: unknown): IteratorResult<T> {
      const result = timed(() => source.return?.(value) ?? { done: true, value: undefined as T });
      record('ok');
      return result;
    },
    throw(error: unknown): IteratorResult<T> {
      try {
        const result = timed(
          () =>
            source.throw?.(error) ?? ({ done: true, value: undefined as T } as IteratorResult<T>)
        );
        record('ok');
        return result;
      } catch (thrown) {
        record('error');
        throw thrown;
      }
    },
    [Symbol.iterator](): IterableIterator<T> {
      return wrapper;
    },
  };

  return wrapper;
}

export function createObservedStatementProxy<T extends object>(
  native: T,
  observer: SQLiteQueryObserver,
  descriptor: SQLiteQueryDescriptor
): T {
  return new Proxy(native, {
    get(target, prop) {
      if (prop === 'get' || prop === 'all' || prop === 'run') {
        const operation = prop;
        const nativeMethod = Reflect.get(target, prop, target) as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown =>
          observeStatementExecution(observer, descriptor, operation, () =>
            nativeMethod.apply(target, args)
          );
      }
      if (prop === 'iterate') {
        const nativeMethod = Reflect.get(target, prop, target) as (
          ...args: unknown[]
        ) => IterableIterator<unknown>;
        return (...args: unknown[]): IterableIterator<unknown> =>
          observeIterateExecution(
            () => nativeMethod.apply(target, args) as IterableIterator<never>,
            observer,
            descriptor
          );
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });
}

export function observeExecExecution<T>(
  observer: SQLiteQueryObserver,
  sql: string,
  invoke: () => T
): T {
  const descriptor = createSQLiteQueryDescriptor(sql);
  const start = performance.now();
  try {
    const result = invoke();
    observer.recordExecution({
      descriptor,
      operation: 'exec',
      durationMs: performance.now() - start,
      outcome: 'ok',
    });
    return result;
  } catch (error) {
    observer.recordExecution({
      descriptor,
      operation: 'exec',
      durationMs: performance.now() - start,
      outcome: 'error',
    });
    throw error;
  }
}
