import { describe, expect, test } from 'bun:test';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration240 } from '../../../../../src/storage/schema/m240-space-manager-handle.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  const insertSpace = db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, slug, created_at, updated_at)
			VALUES (?, ?, ?, ?, 1, 1)`
  );
  insertSpace.run('space-1', '/tmp/space-1', 'Space 1', 'space-1');
  insertSpace.run('space-2', '/tmp/space-2', 'Space 2', 'space-2');
  insertSpace.run('space-3', '/tmp/space-3', 'Space 3', 'space-3');
  insertSpace.run('space-4', '/tmp/space-4', 'Space 4', 'space-4');
  insertSpace.run('space-5', '/tmp/space-5', 'Space 5', 'space-5');
  const insertAgent = db.prepare(
    `INSERT INTO space_long_horizon_agents (
			id, space_id, handle, display_name, template_key, status, session_id,
			instructions, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, '', 1, 1)`
  );
  insertAgent.run(
    'agent-coord-1',
    'space-1',
    'coordinator',
    'Coordinator',
    'coordinator.default',
    'active',
    'space:chat:space-1'
  );
  insertAgent.run('agent-reviewer', 'space-2', 'reviewer', 'Reviewer', null, 'active', null);
  insertAgent.run(
    'agent-manager-3',
    'space-3',
    'space-manager',
    'Custom Manager',
    null,
    'active',
    null
  );
  insertAgent.run(
    'agent-coord-3',
    'space-3',
    'coordinator',
    'Coordinator',
    'coordinator.default',
    'active',
    'space:chat:space-3'
  );
  insertAgent.run(
    'agent-squatter',
    'space-3',
    'space-manager-migrated-agent-manager-3',
    'Squatter',
    null,
    'active',
    null
  );
  insertAgent.run(
    'agent-coord-4',
    'space-4',
    'coordinator',
    'My Coordinator',
    'coordinator.default',
    'active',
    'space:chat:space-4'
  );
  insertAgent.run(
    '0f1e2d3c-4b5a-6978-8976-a5b4c3d2e1f0',
    'space-5',
    'space-manager',
    'Long Id Holder',
    null,
    'active',
    null
  );
  insertAgent.run(
    'agent-squatter-5',
    'space-5',
    'space-manager-migrated-0f1e2d3c-4b5a-6978-8976-a5b4c3d2e1f0',
    'Long Id Squatter',
    null,
    'active',
    null
  );
  insertAgent.run(
    'agent-coord-5',
    'space-5',
    'coordinator',
    'Coordinator',
    'coordinator.default',
    'active',
    'space:chat:space-5'
  );
  return db;
}

function rowById(db: BunDatabase, id: string): { handle: string; display_name: string } {
  return db
    .prepare(`SELECT handle, display_name FROM space_long_horizon_agents WHERE id = ?`)
    .get(id) as { handle: string; display_name: string };
}

function handleById(db: BunDatabase, id: string): string {
  return rowById(db, id).handle;
}

describe('Migration 240: rename coordinator handle to space-manager', () => {
  test('renames coordinator rows per space and leaves other handles untouched', () => {
    const db = makeDb();
    runMigration240(db);

    expect(handleById(db, 'agent-coord-1')).toBe('space-manager');
    expect(handleById(db, 'agent-reviewer')).toBe('reviewer');
    db.close();
  });

  test('relocates a pre-existing active space-manager holder to a collision-free handle', () => {
    const db = makeDb();
    runMigration240(db);

    expect(handleById(db, 'agent-manager-3')).toBe('space-manager-migrated-agent-manager-3-2');
    expect(handleById(db, 'agent-squatter')).toBe('space-manager-migrated-agent-manager-3');
    expect(handleById(db, 'agent-coord-3')).toBe('space-manager');
    db.close();
  });

  test('renamed rows keep resolving through the repository coordinator lookup', () => {
    const db = makeDb();
    runMigration240(db);

    const repo = new SpaceLongHorizonAgentRepository(db);
    expect(repo.getCoordinator('space-1')?.id).toBe('agent-coord-1');
    expect(repo.getCoordinatorRecord('space-1')?.id).toBe('agent-coord-1');
    expect(repo.getCoordinator('space-3')?.id).toBe('agent-coord-3');
    db.close();
  });

  test('keeps collision-generated replacement handles within the slug limit', () => {
    const db = makeDb();
    runMigration236(db);

    const relocated = handleById(db, '0f1e2d3c-4b5a-6978-8976-a5b4c3d2e1f0');
    expect(relocated.startsWith('space-manager-migrated-')).toBe(true);
    expect(relocated).not.toBe('space-manager-migrated-0f1e2d3c-4b5a-6978-8976-a5b4c3d2e1f0');
    expect(relocated.length).toBeLessThanOrEqual(60);
    expect(handleById(db, 'agent-coord-5')).toBe('space-manager');
    db.close();
  });

  test('restamps pristine coordinator display names and preserves customized ones', () => {
    const db = makeDb();
    runMigration236(db);

    expect(rowById(db, 'agent-coord-1').display_name).toBe('Space Manager');
    expect(rowById(db, 'agent-coord-4').display_name).toBe('My Coordinator');
    db.close();
  });

  test('is idempotent', () => {
    const db = makeDb();
    runMigration240(db);
    runMigration240(db);

    expect(handleById(db, 'agent-coord-1')).toBe('space-manager');
    expect(handleById(db, 'agent-coord-3')).toBe('space-manager');
    expect(handleById(db, 'agent-manager-3')).toBe('space-manager-migrated-agent-manager-3-2');
    db.close();
  });
});
