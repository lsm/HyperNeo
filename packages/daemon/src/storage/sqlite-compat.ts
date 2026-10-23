import type { Database as NodeDatabase } from './sqlite-node.ts';
import {
  createObservedStatementProxy,
  observeExecExecution,
  observeSQLitePhase,
  SQLiteQueryObserver,
  type SQLiteQueryObservabilityOptions,
} from './sqlite-query-observability.ts';
import { createSQLiteQueryDescriptor } from './sqlite-query-normalization.ts';
import { STATEMENT_CACHE_CAPACITY, StatementCache } from './statement-cache.ts';

const isBun = typeof Bun !== 'undefined';

const TRANSACTION_CONTROL_SQL_PATTERN = /^\s*(begin|commit|rollback|savepoint|release)\b/i;

let Database: typeof NodeDatabase;
if (isBun) {
  const { Database: BunDatabaseImpl } = await import('bun:sqlite');
  type BunStatement = ReturnType<InstanceType<typeof BunDatabaseImpl>['prepare']>;
  class CachedDatabase extends BunDatabaseImpl {
    private readonly statementCache = new StatementCache<BunStatement>(STATEMENT_CACHE_CAPACITY);
    private queryObserver: SQLiteQueryObserver | null = null;

    constructor(
      path: string,
      options?: ConstructorParameters<typeof BunDatabaseImpl>[1] & {
        queryObservability?: SQLiteQueryObservabilityOptions;
      }
    ) {
      const rest: Record<string, unknown> = {};
      if (options) Object.assign(rest, options);
      delete rest.queryObservability;
      const observer = options?.queryObservability
        ? new SQLiteQueryObserver(options.queryObservability)
        : null;
      const started = observer ? performance.now() : 0;
      try {
        super(path, (Object.keys(rest).length > 0 ? rest : undefined) as never);
      } catch (error) {
        observer?.recordPhase('open', '', started, performance.now(), 'error');
        observer?.close();
        throw error;
      }
      this.queryObserver = observer;
      observer?.recordPhase('open', '', started, performance.now(), 'ok');
    }

    // @ts-expect-error — return type is the concrete bun statement, not the generic base's
    override prepare(sql: string, options?: unknown): BunStatement {
      if (options !== undefined) {
        return this.observeStatement(this.prepareNative(sql, options), sql);
      }
      const cached = this.statementCache.get(sql);
      if (cached) return cached;
      const statement = this.observeStatement(this.prepareNative(sql), sql);
      this.statementCache.set(sql, statement);
      return statement;
    }

    private prepareNative(sql: string, options?: unknown): BunStatement {
      const observer = this.queryObserver;
      return observer
        ? observeSQLitePhase(observer, 'prepare', sql, () => super.prepare(sql, options as never))
        : super.prepare(sql, options as never);
    }

    private observeStatement(statement: BunStatement, sql: string): BunStatement {
      const observer = this.queryObserver;
      if (!observer) return statement;
      return createObservedStatementProxy(
        statement,
        observer,
        createSQLiteQueryDescriptor(sql)
      ) as unknown as BunStatement;
    }

    // @ts-expect-error — alias narrowed to the cached, observed prepare result
    override query(sql: string): BunStatement {
      if (TRANSACTION_CONTROL_SQL_PATTERN.test(sql)) {
        return super.query(sql) as BunStatement;
      }
      return this.prepare(sql);
    }

    override run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
      if (TRANSACTION_CONTROL_SQL_PATTERN.test(sql)) {
        return super.run(sql, ...(params as never[])) as {
          changes: number;
          lastInsertRowid: number;
        };
      }
      return this.prepare(sql).run(...(params as never[])) as {
        changes: number;
        lastInsertRowid: number;
      };
    }

    // @ts-expect-error — bun exec returns Changes via a deprecated bindings overload; keep void semantics
    override exec(sql: string): void {
      const observer = this.queryObserver;
      if (!observer) return super.exec(sql) as unknown as void;
      return observeExecExecution(observer, sql, () => super.exec(sql)) as unknown as void;
    }

    // @ts-expect-error — narrowed return type drops the deferred/immediate/exclusive variants
    override transaction<TArgs extends unknown[], TReturn>(
      fn: (...args: TArgs) => TReturn,
      mode: 'deferred' | 'immediate' | 'exclusive' = 'deferred'
    ): (...args: TArgs) => TReturn {
      const txn = super.transaction(fn) as unknown as {
        immediate?: (...args: TArgs) => TReturn;
        exclusive?: (...args: TArgs) => TReturn;
      } & ((...args: TArgs) => TReturn);
      const variant =
        mode === 'deferred' ? txn : mode === 'immediate' ? txn.immediate : txn.exclusive;
      if (!variant) {
        throw new Error(`bun:sqlite transaction does not expose the ${mode}() variant`);
      }
      const observer = this.queryObserver;
      if (!observer) return mode === 'deferred' ? txn : (...args: TArgs) => variant(...args);
      return (...args: TArgs) =>
        observeExecExecution(observer, 'transaction', () => variant(...args), 'transaction');
    }

    override close(): void {
      this.queryObserver?.close();
      this.queryObserver = null;
      this.statementCache.clear();
      super.close(true);
    }
  }
  Database = CachedDatabase as unknown as typeof NodeDatabase;
} else {
  Database = (await import('./sqlite-node.ts')).Database;
}

export { Database };
export type Database = NodeDatabase;
