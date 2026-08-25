import type * as NodeSqlite from 'node:sqlite';
import {
  createSQLiteQueryDescriptor,
  type SQLiteQueryDescriptor,
} from './sqlite-query-normalization.ts';
import {
  observeExecExecution,
  observeIterateExecution,
  observeStatementExecution,
  SQLiteQueryObserver,
  type SQLiteQueryObservabilityOptions,
} from './sqlite-query-observability.ts';
import { STATEMENT_CACHE_CAPACITY, StatementCache } from './statement-cache.ts';

const { DatabaseSync, StatementSync } = (await import('node:' + 'sqlite')) as typeof NodeSqlite;

type DatabaseSync = NodeSqlite.DatabaseSync;
type StatementSync = NodeSqlite.StatementSync;

interface StatementObservation {
  observer: SQLiteQueryObserver;
  descriptor: SQLiteQueryDescriptor;
}

class CompatStatement<TRow = unknown, TParams extends unknown[] = unknown[]> {
  constructor(
    private readonly stmt: StatementSync,
    private readonly observation: StatementObservation | null = null
  ) {}

  private static bindArgs(args: unknown[]): unknown[] {
    return args.map((v) => (v === undefined ? null : v));
  }

  private rawGet(args: TParams): TRow | null {
    const row = this.stmt.get(...(CompatStatement.bindArgs(args) as unknown as []));
    return (row === undefined ? null : row) as TRow | null;
  }

  get(...args: TParams): TRow | null {
    const observation = this.observation;
    if (!observation) return this.rawGet(args);
    return observeStatementExecution(observation.observer, observation.descriptor, 'get', () =>
      this.rawGet(args)
    );
  }

  private rawAll(args: TParams): TRow[] {
    return this.stmt.all(...(CompatStatement.bindArgs(args) as unknown as [])) as TRow[];
  }

  all(...args: TParams): TRow[] {
    const observation = this.observation;
    if (!observation) return this.rawAll(args);
    return observeStatementExecution(observation.observer, observation.descriptor, 'all', () =>
      this.rawAll(args)
    );
  }

  private rawRun(args: unknown[]): { changes: number; lastInsertRowid: number } {
    return this.stmt.run(...(CompatStatement.bindArgs(args) as unknown as [])) as {
      changes: number;
      lastInsertRowid: number;
    };
  }

  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    const observation = this.observation;
    if (!observation) return this.rawRun(args);
    return observeStatementExecution(observation.observer, observation.descriptor, 'run', () =>
      this.rawRun(args)
    );
  }

  get sourceSQL(): string {
    return this.stmt.sourceSQL;
  }
  get expandedSQL(): string {
    return this.stmt.expandedSQL;
  }

  private rawIterate(args: unknown[]): IterableIterator<TRow> {
    return this.stmt.iterate(
      ...(CompatStatement.bindArgs(args) as unknown as [])
    ) as IterableIterator<TRow>;
  }

  iterate(...args: unknown[]): IterableIterator<TRow> {
    const observation = this.observation;
    if (!observation) return this.rawIterate(args);
    return observeIterateExecution(
      () => this.rawIterate(args),
      observation.observer,
      observation.descriptor
    );
  }

  setReadBigInts(enabled: boolean): void {
    this.stmt.setReadBigInts(enabled);
  }
  setAllowBareNamedParameters(enabled: boolean): void {
    this.stmt.setAllowBareNamedParameters(enabled);
  }
}

export class Database extends DatabaseSync {
  private txDepth = 0;
  private txSavepointSeq = 0;
  private readonly statementCache = new StatementCache<CompatStatement>(STATEMENT_CACHE_CAPACITY);
  private queryObserver: SQLiteQueryObserver | null = null;

  constructor(
    path: string,
    options?: ConstructorParameters<typeof DatabaseSync>[1] & {
      readonly?: boolean;
      queryObservability?: SQLiteQueryObservabilityOptions;
    }
  ) {
    const { readonly, queryObservability, ...rest } = options ?? {};
    super(path, {
      enableForeignKeyConstraints: false,
      ...(readonly ? { readOnly: true } : {}),
      ...rest,
    });
    if (queryObservability) {
      this.queryObserver = new SQLiteQueryObserver(queryObservability);
    }
  }

  exec(sql: string): void {
    const observer = this.queryObserver;
    if (!observer) return super.exec(sql);
    return observeExecExecution(observer, sql, () => super.exec(sql));
  }

  private execUnobserved(sql: string): void {
    super.exec(sql);
  }

  close(): void {
    this.queryObserver?.close();
    this.queryObserver = null;
    this.statementCache.clear();
    super.close();
  }

  transaction<TArgs extends unknown[], TReturn>(
    fn: (...args: TArgs) => TReturn,
    mode: 'deferred' | 'immediate' | 'exclusive' = 'deferred'
  ): (...args: TArgs) => TReturn {
    const beginSql = mode === 'deferred' ? 'BEGIN' : `BEGIN ${mode.toUpperCase()}`;
    return (...args: TArgs): TReturn => {
      const nested = this.txDepth > 0;
      const savepoint = nested ? `hyperneo_sp_${++this.txSavepointSeq}` : null;
      if (nested) {
        this.execUnobserved(`SAVEPOINT ${savepoint}`);
      } else {
        this.execUnobserved(beginSql);
      }
      this.txDepth++;
      try {
        const result = fn(...args);
        this.txDepth--;
        if (nested) {
          this.execUnobserved(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          this.execUnobserved('COMMIT');
        }
        return result;
      } catch (err) {
        this.txDepth--;
        if (nested) {
          this.execUnobserved(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.execUnobserved(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          this.execUnobserved('ROLLBACK');
        }
        throw err;
      }
    };
  }

  // @ts-expect-error — return type widened to the generic compat wrapper
  prepare<TRow = unknown, TParams extends unknown[] = unknown[]>(
    sql: string,
    options?: Parameters<DatabaseSync['prepare']>[1]
  ): CompatStatement<TRow, TParams> {
    const observation = this.statementObservation(sql);
    if (options !== undefined) {
      return new CompatStatement<TRow, TParams>(super.prepare(sql, options), observation);
    }
    const cached = this.statementCache.get(sql);
    if (cached) return cached as CompatStatement<TRow, TParams>;
    const statement = new CompatStatement<TRow, TParams>(super.prepare(sql), observation);
    this.statementCache.set(sql, statement);
    return statement;
  }

  private statementObservation(sql: string): StatementObservation | null {
    if (!this.queryObserver) return null;
    return { observer: this.queryObserver, descriptor: createSQLiteQueryDescriptor(sql) };
  }

  query<TRow = unknown, TParams extends unknown[] = unknown[]>(
    sql: string
  ): CompatStatement<TRow, TParams> {
    return this.prepare<TRow, TParams>(sql);
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    return this.prepare(sql).run(...params);
  }
}

export type { CompatStatement as Statement, DatabaseSync };
export { StatementSync };
export type SqliteDatabase = Database;
