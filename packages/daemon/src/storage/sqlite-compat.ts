import type { Database as NodeDatabase } from './sqlite-node';
import {
  createObservedStatementProxy,
  observeExecExecution,
  SQLiteQueryObserver,
  type SQLiteQueryObservabilityOptions,
} from './sqlite-query-observability';
import { createSQLiteQueryDescriptor } from './sqlite-query-normalization';
import { STATEMENT_CACHE_CAPACITY, StatementCache } from './statement-cache';

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
      super(path, (Object.keys(rest).length > 0 ? rest : undefined) as never);
      if (options?.queryObservability) {
        this.queryObserver = new SQLiteQueryObserver(options.queryObservability);
      }
    }

    // @ts-expect-error — return type is the concrete bun statement, not the generic base's
    override prepare(sql: string, options?: unknown): BunStatement {
      if (options !== undefined) {
        return this.observeStatement(super.prepare(sql, options as never), sql);
      }
      const cached = this.statementCache.get(sql);
      if (cached) return cached;
      const statement = this.observeStatement(super.prepare(sql), sql);
      this.statementCache.set(sql, statement);
      return statement;
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
      if (mode === 'deferred') return txn;
      const variant = mode === 'immediate' ? txn.immediate : txn.exclusive;
      if (!variant) {
        throw new Error(`bun:sqlite transaction does not expose the ${mode}() variant`);
      }
      return (...args: TArgs) => variant(...args);
    }

    override close(): void {
      this.queryObserver?.close();
      this.queryObserver = null;
      this.statementCache.clear();
      super.close();
    }
  }
  Database = CachedDatabase as unknown as typeof NodeDatabase;
} else {
  Database = (await import('./sqlite-node.ts')).Database;
}

export { Database };
export type Database = NodeDatabase;

export type { DatabaseSync, Statement, SqliteDatabase } from './sqlite-node';
