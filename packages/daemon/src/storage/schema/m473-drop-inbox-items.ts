import { Logger } from '../../lib/logger.ts';
import type { Database } from '../sqlite-compat.ts';

const log = new Logger('migration-473');

export function runMigration473(db: Database): void {
  if (
    !db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'inbox_items'`).get()
  )
    return;
  if (db.prepare('SELECT 1 FROM inbox_items LIMIT 1').get()) {
    log.warn('Keeping inbox_items: it still has rows');
    return;
  }
  db.exec('DROP TABLE inbox_items');
}
