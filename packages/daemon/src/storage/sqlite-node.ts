import type * as NodeSqlite from 'node:sqlite';

const { DatabaseSync, StatementSync } = (await import('node:' + 'sqlite')) as typeof NodeSqlite;

type DatabaseSync = NodeSqlite.DatabaseSync;
type StatementSync = NodeSqlite.StatementSync;

class CompatStatement<TRow = unknown, TParams extends unknown[] = unknown[]> {
  constructor(private readonly stmt: StatementSync) {}

  private static bindArgs(args: unknown[]): unknown[] {
    return args.map((v) => (v === undefined ? null : v));
  }

  get(...args: TParams): TRow | null {
    const row = this.stmt.get(...(CompatStatement.bindArgs(args) as unknown as []));
    return (row === undefined ? null : row) as TRow | null;
  }

  all(...args: TParams): TRow[] {
    return this.stmt.all(...(CompatStatement.bindArgs(args) as unknown as [])) as TRow[];
  }

  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    return this.stmt.run(...(CompatStatement.bindArgs(args) as unknown as [])) as {
      changes: number;
      lastInsertRowid: number;
    };
  }

  get sourceSQL(): string {
    return this.stmt.sourceSQL;
  }
  get expandedSQL(): string {
    return this.stmt.expandedSQL;
  }
  iterate(...args: unknown[]): IterableIterator<TRow> {
    return this.stmt.iterate(
      ...(CompatStatement.bindArgs(args) as unknown as [])
    ) as IterableIterator<TRow>;
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

  constructor(
    path: string,
    options?: ConstructorParameters<typeof DatabaseSync>[1] & { readonly?: boolean }
  ) {
    const { readonly, ...rest } = options ?? {};
    super(path, {
      enableForeignKeyConstraints: false,
      ...(readonly ? { readOnly: true } : {}),
      ...rest,
    });
  }

  transaction<TArgs extends unknown[], TReturn>(
    fn: (...args: TArgs) => TReturn
  ): (...args: TArgs) => TReturn {
    return (...args: TArgs): TReturn => {
      const nested = this.txDepth > 0;
      const savepoint = nested ? `hyperneo_sp_${++this.txSavepointSeq}` : null;
      if (nested) {
        this.exec(`SAVEPOINT ${savepoint}`);
      } else {
        this.exec('BEGIN');
      }
      this.txDepth++;
      try {
        const result = fn(...args);
        this.txDepth--;
        if (nested) {
          this.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          this.exec('COMMIT');
        }
        return result;
      } catch (err) {
        this.txDepth--;
        if (nested) {
          this.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          this.exec('ROLLBACK');
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
    return new CompatStatement<TRow, TParams>(super.prepare(sql, options));
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
