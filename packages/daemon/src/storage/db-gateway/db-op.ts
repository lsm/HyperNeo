import type { Database } from '../sqlite-compat.ts';

export interface DbOp<A, R> {
  readonly name: string;
  readonly mode: 'read' | 'write';
  readonly run: (db: Database, args: A) => R;
}

export function defineDbOp<A, R>(op: DbOp<A, R>): DbOp<A, R> {
  return op;
}
