import { Logger } from '../../lib/logger.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

const log = new Logger('migration-268');

const LEGACY_TABLE = 'space_long_horizon_agent_forge_scopes';
const CURRENT_TABLE = 'space_long_horizon_agent_evolution_scopes';

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

export function runMigration268(db: BunDatabase): void {
  if (!tableExists(db, LEGACY_TABLE) || tableExists(db, CURRENT_TABLE)) return;
  db.exec(`ALTER TABLE ${LEGACY_TABLE} RENAME TO ${CURRENT_TABLE}`);
  log.info(`Renamed ${LEGACY_TABLE} to ${CURRENT_TABLE}`);
}
