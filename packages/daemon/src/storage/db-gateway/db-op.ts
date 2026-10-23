import type { Database } from '../sqlite-compat.ts';

export interface DbOp<A, R> {
  readonly name: string;
  readonly mode: 'read' | 'write';
  readonly run: (db: Database, args: A) => R;
}

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
  readonly Repository: new (db: Database) => R;
}

export function defineRepositoryOp<R, M extends Method<R>>(
  name: string,
  mode: DbOp<unknown, unknown>['mode'],
  Repository: new (db: Database) => R,
  methods: readonly M[]
): RepositoryOp<R, M> {
  const allowed = new Set<string>(methods);
  return {
    name,
    mode,
    methods,
    Repository,
    run: (db, { method, args }) => {
      if (!allowed.has(method)) throw new Error(`${name} does not run ${method}`);
      const repository = new Repository(db) as Record<string, (...args: unknown[]) => unknown>;
      return repository[method](...args);
    },
  };
}
