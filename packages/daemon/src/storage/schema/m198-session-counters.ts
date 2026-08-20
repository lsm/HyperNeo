import type { Database as BunDatabase } from '../sqlite-compat';
import { backfillSessionCounters, createSessionCounters } from './session-counters';

export function runMigration198(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) return;
  createSessionCounters(db);
  backfillSessionCounters(db);
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
}
