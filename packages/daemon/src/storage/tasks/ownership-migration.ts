import type { Database } from '../sqlite-compat.ts';
import { buildStandaloneTaskTableSql } from './ownership-ddl.ts';

export function migrateStandaloneTaskOwnership(db: Database): void {
  const foreignKeys = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number })
    .foreign_keys;
  const legacyAlter = (
    db.prepare('PRAGMA legacy_alter_table').get() as { legacy_alter_table: number }
  ).legacy_alter_table;
  let started = false;
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    if ((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys !== 0) {
      throw new Error('Task ownership migration requires no active transaction');
    }
    db.exec('BEGIN IMMEDIATE');
    started = true;
    const table = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'space_tasks'")
      .get() as { sql: string } | null;
    if (table) {
      const columns = db.prepare('PRAGMA table_info(space_tasks)').all() as Array<{
        name: string;
        notnull: number;
      }>;
      const migrated =
        ['space_id', 'task_number'].every((name) =>
          columns.some((column) => column.name === name && column.notnull === 0)
        ) && table.sql.includes('CHECK ((space_id IS NULL AND task_number IS NULL)');
      if (!migrated) {
        const replacement = buildStandaloneTaskTableSql(table.sql);
        const schemaObjects = db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE tbl_name = 'space_tasks' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name"
          )
          .all() as Array<{ sql: string }>;
        const columnNames = columns.map(({ name }) => `"${name.replaceAll('"', '""')}"`).join(', ');
        db.exec('PRAGMA legacy_alter_table = ON');
        db.exec(replacement);
        db.exec(
          `INSERT INTO task_ownership_rebuild (${columnNames}) SELECT ${columnNames} FROM space_tasks`
        );
        db.exec('DROP TABLE space_tasks');
        db.exec('ALTER TABLE task_ownership_rebuild RENAME TO space_tasks');
        for (const object of schemaObjects) db.exec(object.sql);
        if (db.prepare('PRAGMA foreign_key_check').all().length > 0) {
          throw new Error('Task ownership migration found foreign-key violations');
        }
      }
    }
    db.exec('COMMIT');
    started = false;
  } catch (error) {
    if (started) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec(`PRAGMA legacy_alter_table = ${legacyAlter}`);
    db.exec(`PRAGMA foreign_keys = ${foreignKeys}`);
  }
}
