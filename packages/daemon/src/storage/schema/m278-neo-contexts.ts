import type { Database } from '../sqlite-compat.ts';
import { createNeoContextTables } from './neo.ts';

export function runMigration278(db: Database): void {
  createNeoContextTables(db);
}
