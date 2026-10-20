import type { Database } from '../sqlite-compat.ts';
import { runMigration413 } from './m413-sdk-message-columns.ts';

export function runMigration414(db: Database): void {
  runMigration413(db);
}
