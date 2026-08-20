import type { Database as NodeDatabase } from './sqlite-node';
import { STATEMENT_CACHE_CAPACITY, StatementCache } from './statement-cache';

const isBun = typeof Bun !== 'undefined';

let Database: typeof NodeDatabase;
if (isBun) {
  const { Database: BunDatabaseImpl } = await import('bun:sqlite');
  type BunStatement = ReturnType<InstanceType<typeof BunDatabaseImpl>['prepare']>;
  class CachedDatabase extends BunDatabaseImpl {
    private readonly statementCache = new StatementCache<BunStatement>(STATEMENT_CACHE_CAPACITY);

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
