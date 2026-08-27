import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat';
import { SpaceGoalRepository } from '../../../../../src/storage/repositories/space-goal-repository';
import { SpaceRepository } from '../../../../../src/storage/repositories/space-repository';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration218 } from '../../../../../src/storage/schema/m218-space-goals-workspace-path.ts';

function columnNames(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}

function hasMigrationMarker(db: Database, key: string): boolean {
  const row = db.prepare(`SELECT key FROM migration_markers WHERE key = ?`).get(key);
  return !!row;
}

let db: Database;

describe('migration 218: space_goals workspace_path', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  test('adds workspace_path and leaves existing rows null', () => {
    db.exec(`CREATE TABLE space_goals (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
    db.exec(`INSERT INTO space_goals (id, title) VALUES ('g1', 'Goal')`);

    expect(columnNames(db, 'space_goals')).not.toContain('workspace_path');

    runMigration218(db);

    expect(columnNames(db, 'space_goals')).toContain('workspace_path');
    const row = db.prepare(`SELECT workspace_path FROM space_goals WHERE id = ?`).get('g1') as {
      workspace_path: string | null;
    };
    expect(row.workspace_path).toBeNull();
  });

  test('is idempotent', () => {
    db.exec(`CREATE TABLE space_goals (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);

    runMigration218(db);
    runMigration218(db);

    expect(columnNames(db, 'space_goals').filter((c) => c === 'workspace_path')).toHaveLength(1);
  });

  test('is a no-op when space_goals does not exist', () => {
    expect(() => runMigration218(db)).not.toThrow();
  });

  test('fresh DB runs through migrations and records the marker', () => {
    createTables(db);
    runMigrations(db, () => {});

    expect(columnNames(db, 'space_goals')).toContain('workspace_path');
    expect(hasMigrationMarker(db, 'migration_218')).toBe(true);
  });

  test('round-trips workspacePath through the repository', () => {
    createTables(db);
    runMigrations(db, () => {});

    const spaceRepo = new SpaceRepository(db);
    const goalRepo = new SpaceGoalRepository(db);
    const space = spaceRepo.createSpace({
      slug: 'test',
      workspacePath: '/workspace/test',
      name: 'Test Space',
    });

    const created = goalRepo.create({
      spaceId: space.id,
      title: 'Goal',
      workspacePath: '/workspace/goal',
    });
    expect(created.workspacePath).toBe('/workspace/goal');

    const read = goalRepo.getById(created.id);
    expect(read?.workspacePath).toBe('/workspace/goal');

    const updated = goalRepo.update(created.id, { workspacePath: '/workspace/updated' });
    expect(updated?.workspacePath).toBe('/workspace/updated');

    const nulled = goalRepo.update(created.id, { workspacePath: null });
    expect(nulled?.workspacePath).toBeNull();
  });
});
