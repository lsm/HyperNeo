import type { Database as NodeDatabase } from './sqlite-node';

const isBun = typeof Bun !== 'undefined';

const Database: typeof NodeDatabase = isBun
  ? ((await import('bun:sqlite')).Database as unknown as typeof NodeDatabase)
  : (await import('./sqlite-node.ts')).Database;

export { Database };
export type Database = NodeDatabase;

export type { DatabaseSync, Statement, SqliteDatabase } from './sqlite-node';
