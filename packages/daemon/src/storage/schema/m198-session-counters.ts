import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { backfillSessionCounters, createSessionCounters } from './session-counters.ts';

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
