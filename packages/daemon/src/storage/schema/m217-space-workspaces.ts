import { generateUUID } from '@hyperneo/shared';
import { Logger } from '../../lib/logger.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

const log = new Logger('migration-217');

interface SpaceRow {
  id: string;
  workspace_path: string;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
    .get(columnName);
}

function deriveLabel(workspacePath: string): string {
  const trimmed = workspacePath.replace(/[\\/]+$/, '').trim();
  if (trimmed.length === 0) return '';
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

export function runMigration217(db: BunDatabase): void {
  if (!tableExists(db, 'spaces')) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS space_workspaces (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      path TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(space_id, path),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_workspaces_space_id ON space_workspaces(space_id)`);

  if (!tableHasColumn(db, 'spaces', 'workspace_path')) return;

  const hasPrimary = db.prepare(
    `SELECT 1 FROM space_workspaces WHERE space_id = ? AND is_primary = 1 LIMIT 1`
  );

  const spaces = db
    .prepare(
      `SELECT id, workspace_path
       FROM spaces
       WHERE workspace_path IS NOT NULL AND workspace_path != ''`
    )
    .all() as SpaceRow[];
  if (spaces.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO space_workspaces
       (id, space_id, path, label, is_primary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const now = Date.now();
  let totalInserted = 0;

  for (const space of spaces) {
    if (hasPrimary.get(space.id)) continue;
    insert.run(
      generateUUID(),
      space.id,
      space.workspace_path,
      deriveLabel(space.workspace_path),
      1,
      now,
      now
    );
    totalInserted++;
  }

  if (totalInserted > 0) {
    log.info(`[backfill] Inserted ${totalInserted} primary workspace row(s).`);
  }
}
