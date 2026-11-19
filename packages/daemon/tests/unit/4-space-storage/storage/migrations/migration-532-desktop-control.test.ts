import { describe, expect, test } from 'vitest';
import { runMigrations } from '../../../../../src/storage/schema/migrations.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('runMigrations', () => {
  test('installs desktop control and worker roles, including on an already migrated database', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, () => {});
      const columns = () =>
        (db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[]).map(
          (column) => column.name
        );
      expect(columns()).toContain('desktop_app');
      expect(
        db.prepare("SELECT name FROM sqlite_schema WHERE name = 'neo_todo_roles'").get()
      ).toBeTruthy();
      db.exec(
        "ALTER TABLE neo_questions DROP COLUMN desktop_app; DELETE FROM migration_markers WHERE key = 'migration_532'"
      );
      runMigrations(db, () => {});
      expect(columns()).toContain('desktop_app');
      expect(
        db.prepare("SELECT name FROM sqlite_schema WHERE name = 'neo_todo_roles'").get()
      ).toBeTruthy();
    } finally {
      db.close();
    }
  });
});
