import type { ReactiveDatabase, TableChangeScope } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';

export type TableChange = { table: string; scope?: TableChangeScope };

export class ChangeRecorder {
  readonly changes: TableChange[] = [];

  notifyChange(table: string, scope?: TableChangeScope): void {
    this.changes.push(scope ? { table, scope } : { table });
  }

  beginTransaction(): void {}

  commitTransaction(): void {}

  abortTransaction(): void {}
}

export interface DbOp<A, R> {
  readonly name: string;
  readonly mode: 'read' | 'write';
  readonly run: (db: Database, args: A, changes: ChangeRecorder) => R;
}

export type RunDbOp = <A, R>(op: DbOp<A, R>, args: A) => Promise<R>;

export function defineDbOp<A, R>(op: DbOp<A, R>): DbOp<A, R> {
  return op;
}

export type Method<R> = {
  [K in keyof R]: R[K] extends (...args: never[]) => unknown ? K : never;
}[keyof R] &
  string;

type MethodCall = { method: string; args: unknown[] };

export interface RepositoryOp<R, M extends Method<R>> extends DbOp<MethodCall, unknown> {
  readonly methods: readonly M[];
  readonly Repository: new (db: Database, reactiveDb?: ReactiveDatabase) => R;
}

export function defineRepositoryOp<R, M extends Method<R>>(
  name: string,
  mode: DbOp<unknown, unknown>['mode'],
  Repository: new (db: Database, reactiveDb?: ReactiveDatabase) => R,
  methods: readonly M[]
): RepositoryOp<R, M> {
  const allowed = new Set<string>(methods);
  return {
    name,
    mode,
    methods,
    Repository,
    run: (db, { method, args }, changes) => {
      if (!allowed.has(method)) throw new Error(`${name} does not run ${method}`);
      const repository = new Repository(db, changes as unknown as ReactiveDatabase) as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return repository[method](...args);
    },
  };
}
