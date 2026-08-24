import type { Database as NodeDatabase } from './sqlite-node';
import { STATEMENT_CACHE_CAPACITY, StatementCache } from './statement-cache';

const isBun = typeof Bun !== 'undefined';

let Database: typeof NodeDatabase;
if (isBun) {
  const { Database: BunDatabaseImpl } = await import('bun:sqlite');
  type BunStatement = ReturnType<InstanceType<typeof BunDatabaseImpl>['prepare']>;
  class CachedDatabase extends BunDatabaseImpl {
    private readonly statementCache = new StatementCache<BunStatement>(STATEMENT_CACHE_CAPACITY);

    constructor(...args: ConstructorParameters<typeof BunDatabaseImpl>) {
      super(...args);
      this.exec('PRAGMA case_sensitive_like = ON');
    }

    // @ts-expect-error — return type is the concrete bun statement, not the generic base's
    override prepare(sql: string, options?: unknown): BunStatement {
      if (options !== undefined) {
        return super.prepare(sql, options as never);
      }
      const cached = this.statementCache.get(sql);
      if (cached) return cached;
      const statement = super.prepare(sql);
      this.statementCache.set(sql, statement);
      return statement;
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
