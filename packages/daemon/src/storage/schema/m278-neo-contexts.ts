import type { Database } from '../sqlite-compat.ts';
import { createNeoTables } from './neo.ts';

export function runMigration278(db: Database): void {
  createNeoTables(db);
}
