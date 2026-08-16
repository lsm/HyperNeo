/**
 * SQLite compatibility layer — Node backend.
 *
 * Loaded only under Node (and Deno later) via the runtime-agnostic entry in
 * `sqlite-compat.ts`, which dynamically imports this module. Import `Database`
 * from `sqlite-compat`, not from here. Under Bun the entry re-exports
 * `bun:sqlite`'s native `Database` instead (it already matches the contract
 * below).
 *
 * Targets Node's built-in `node:sqlite` (`DatabaseSync`), which is also what
 * Deno 2.9 supports. This wrapper subclasses `DatabaseSync` and adds the
 * `bun:sqlite` conveniences the codebase relies on, so existing call sites are
 * unchanged:
 *
 * - `db.transaction(fn)` → returns a callable that runs `fn` inside a
 *   BEGIN/COMMIT, rolling back on throw. Only the default immediate-invoke
 *   form (`db.transaction(fn)()`) is supported — bun's `.immediate`/`.deferred`/
 *   `.exclusive` variants were never used.
 * - `db.query(sql)` → bun's cached-prepare. We simply forward to `prepare()`;
 *   `DatabaseSync` caches prepared statements internally well enough for our
 *   (very light, 3-call-site) usage.
 * - `stmt.get()` returns `null` (not `undefined`) when no row matches.
 *   `node:sqlite` returns `undefined` for a miss, but bun:sqlite returned
 *   `null`, and both production code (functions typed `Session | null`) and
 *   ~1200 test assertions (`.toBeNull()`) depend on that. We normalize `get()`
 *   to return `null` to preserve bun's contract exactly.
 * - FOREIGN KEYS default OFF (bun's default; `node:sqlite` defaults ON). See
 *   the constructor.
 * - `stmt.run()` returns `{ changes, lastInsertRowid }` — identical shape.
 */

/**
 * `node:sqlite` must be imported via a computed specifier: Bun standalone
 * executables (`bun build --compile`) do not embed this builtin, and a statically
 * resolvable reference anywhere in the module graph makes the compiled binary
 * abort at startup with "No such built-in module: node:sqlite" — even though
 * `sqlite-compat.ts` only loads this module under Node. Bun's bundler folds
 * literal concatenation in dynamic-import specifiers of *entry* modules, but
 * not when the concatenation sits in a lazily-imported child module like this
 * one, so the split specifier keeps the reference runtime-only. The type is
 * still sourced statically via the erased `typeof import(...)` below.
 */
import type * as NodeSqlite from 'node:sqlite';

const { DatabaseSync, StatementSync } = (await import('node:' + 'sqlite')) as typeof NodeSqlite;

// Restore the type-space meanings a class import would have provided (the
// destructured consts above exist only in value space). A same-named type alias
// and const coexist, so downstream `type { DatabaseSync }` / `StatementSync`
// annotations see the instance types exactly as before.
type DatabaseSync = NodeSqlite.DatabaseSync;
type StatementSync = NodeSqlite.StatementSync;

/**
 * A `StatementSync` wrapper matching bun:sqlite's `Statement` contract:
 * - `get()` returns `null` (bun semantics) instead of `undefined` on a miss.
 * - Generic over the row type: `stmt.get<Row>()` / `stmt.all<Row>()` return
 *   `Row | null` / `Row[]`, matching bun:sqlite's `<TRow, TParams>` generics so
 *   call sites like `db.query<CredentialRow, [string]>(sql).get(id)` keep their
 *   typed rows (`row.iv`). Without the generic the row is `unknown` and these
 *   become TS2558/TS2339 errors.
 * - `run()` returns `{ changes, lastInsertRowid }` typed as `number`. The
 *   schema has no BIGINT columns, so `node:sqlite`'s `number | bigint` union
 *   is narrowed to `number` for drop-in compatibility with existing reads.
 */
class CompatStatement<TRow = unknown, TParams extends unknown[] = unknown[]> {
  constructor(private readonly stmt: StatementSync) {}

  /**
   * Normalize bind values to match bun:sqlite's lenient binding: bun binds
   * `undefined` as SQL NULL, but `node:sqlite` throws
   * "Provided value cannot be bound to SQLite parameter N" for `undefined`.
   * Coerce `undefined` → `null` so existing call sites (which relied on bun's
   * behaviour) work unchanged under node:sqlite.
   */
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

  // Pass-throughs for the less-used members.
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
  /**
   * Transaction nesting depth, used to emulate bun:sqlite's nested-transaction
   * behaviour: the outermost call issues BEGIN/COMMIT, nested calls issue
   * SAVEPOINT/RELEASE so a nested `db.transaction(fn)()` does not error with
   * "cannot start a transaction within a transaction".
   */
  private txDepth = 0;
  private txSavepointSeq = 0;

  /**
   * Match bun:sqlite's default of FOREIGN KEYS OFF. `node:sqlite` enables
   * foreign-key enforcement by default; bun does not. The storage layer (and
   * its migrations/tests) were written against bun's FK-OFF default and toggle
   * it explicitly where needed (`database-core.ts` sets `PRAGMA foreign_keys =
   * ON` for production). Defaulting to OFF here preserves that behaviour
   * without rewriting call sites. Callers that pass their own options object
   * keep full control.
   */
  constructor(
    path: string,
    options?: ConstructorParameters<typeof DatabaseSync>[1] & { readonly?: boolean }
  ) {
    // Normalize the bun:sqlite-native `readonly` spelling to node:sqlite's
    // `readOnly`. The two runtimes disagree: bun:sqlite rejects `readOnly`
    // ("Misspelled option"), while node:sqlite silently ignores `readonly`
    // (opening read-write). Prod/dev run under Bun, so call sites use `readonly`
    // (Bun's spelling) and we translate it here so the same option opens
    // read-only under Node (tests / tsx) too.
    const { readonly, ...rest } = options ?? {};
    super(path, {
      enableForeignKeyConstraints: false,
      ...(readonly ? { readOnly: true } : {}),
      ...rest,
    });
  }

  /**
   * bun:sqlite-compatible transaction helper. Returns a function that, when
   * invoked, executes `fn` inside a transaction.
   */
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

  /**
   * Prepare a statement, wrapped so `get()` returns `null` on a miss (bun
   * semantics) rather than `undefined`, and `get()`/`all()` are generic over
   * the row type. Accepts bun:sqlite's `<TRow, TParams>` type arguments (the
   * params type is not enforced, matching bun). The `prepare` return type is
   * `CompatStatement<TRow>`; this widens the base `StatementSync` return, so we
   * suppress the base-class override incompatibility.
   */
  // @ts-expect-error — return type widened to the generic compat wrapper
  prepare<TRow = unknown, TParams extends unknown[] = unknown[]>(
    sql: string,
    options?: Parameters<DatabaseSync['prepare']>[1]
  ): CompatStatement<TRow, TParams> {
    return new CompatStatement<TRow, TParams>(super.prepare(sql, options));
  }

  /**
   * bun:sqlite-compatible cached-prepare. Forwards to `prepare()`.
   */
  query<TRow = unknown, TParams extends unknown[] = unknown[]>(
    sql: string
  ): CompatStatement<TRow, TParams> {
    return this.prepare<TRow, TParams>(sql);
  }

  /**
   * bun:sqlite-compatible `db.run(sql, ...params)` — shorthand for
   * `prepare(sql).run(...params)`, returning `{ changes, lastInsertRowid }`.
   */
  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    return this.prepare(sql).run(...params);
  }
}

export type { CompatStatement as Statement, DatabaseSync };
export { StatementSync };
/**
 * The handle type repositories/tests receive. Kept as `Database` so existing
 * `import type { Database as BunDatabase }` call sites keep working after the
 * import specifier is repointed to this module.
 */
export type SqliteDatabase = Database;
