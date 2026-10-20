import type { Database } from '../sqlite-compat.ts';
import { createSdkMessageFilterIndexes } from './sdk-message-filter-indexes.ts';

export function runMigration417(db: Database): void {
  createSdkMessageFilterIndexes(db);
}
