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
  insertSpace.run('space-6', '/tmp/space-6', 'Space 6', 'space-6');
  insertSpace.run('space-7', '/tmp/space-7', 'Space 7', 'space-7');
  insertSpace.run('space-8', '/tmp/space-8', 'Space 8', 'space-8');
  insertSpace.run('space-9', '/tmp/space-9', 'Space 9', 'space-9');
  insertSpace.run('space-11', '/tmp/space-11', 'Space 11', 'space-11');
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
  insertAgent.run(
    'agent-archived-6',
    'space-6',
    'space-manager',
    'Archived Holder',
    null,
    'archived',
    null
  );
  insertAgent.run(
    'agent-coord-6',
    'space-6',
    'coordinator',
    'Coordinator',
    'coordinator.default',
    'active',
    'space:chat:space-6'
  );
  insertAgent.run(
    'agent-named-manager-7',
    'space-7',
    'custom-named',
    'space manager',
    null,
    'active',
    null
  );
  insertAgent.run(
    'agent-coord-7',
    'space-7',
    'coordinator',
    'Coordinator',
    'coordinator.default',
    'active',
    'space:chat:space-7'
  );
  insertAgent.run(
    'space-lh-agent:coordinator:space-8',
    'space-8',
    'renamed-prelock',
    'Coordinator',
    'coordinator.default',
    'active',
    'space:chat:space-8'
  );
  insertAgent.run('agent-holder-8', 'space-8', 'space-manager', 'Holder', null, 'active', null);
  insertAgent.run(
    'agent-archived-named-9',
    'space-9',
    'archived-named',
    'Space Manager',
    null,
    'archived',
    null
  );
  insertAgent.run(
    'agent-coord-9',
    'space-9',
    'coordinator',
    'Coordinator',
    'coordinator.default',
    'active',
    'space:chat:space-9'
  );
  insertAgent.run(
    'agent-archived-coordinator-11',
    'space-11',
    'coordinator',
    'Old Duplicate',
    null,
    'archived',
    null
  );
  insertAgent.run(
    'agent-coord-11',
    'space-11',
    'coordinator',
    'Coordinator',
    'coordinator.default',
    'active',
    'space:chat:space-11'
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
    runMigration239(db);

    const relocated = handleById(db, '0f1e2d3c-4b5a-6978-8976-a5b4c3d2e1f0');
    expect(relocated.startsWith('space-manager-migrated-')).toBe(true);
    expect(relocated).not.toBe('space-manager-migrated-0f1e2d3c-4b5a-6978-8976-a5b4c3d2e1f0');
    expect(relocated.length).toBeLessThanOrEqual(60);
    expect(handleById(db, 'agent-coord-5')).toBe('space-manager');
    db.close();
  });

  test('restamps pristine coordinator display names and preserves customized ones', () => {
    const db = makeDb();
    runMigration239(db);

    expect(rowById(db, 'agent-coord-1').display_name).toBe('Space Manager');
    expect(rowById(db, 'agent-coord-4').display_name).toBe('My Coordinator');
    db.close();
  });

  test('skips the display-name restamp when a custom agent already owns the name', () => {
    const db = makeDb();
    runMigration239(db);

    expect(rowById(db, 'agent-coord-7').handle).toBe('space-manager');
    expect(rowById(db, 'agent-coord-7').display_name).toBe('Coordinator');
    expect(rowById(db, 'agent-named-manager-7').display_name).toBe('space manager');
    db.close();
  });

  test('skips the restamp when an archived custom agent owns the name', () => {
    const db = makeDb();
    runMigration239(db);

    expect(rowById(db, 'agent-coord-9').handle).toBe('space-manager');
    expect(rowById(db, 'agent-coord-9').display_name).toBe('Coordinator');
    expect(rowById(db, 'agent-archived-named-9').display_name).toBe('Space Manager');
    db.close();
  });

  test('relocates holders when the coordinator row was pre-lock renamed', () => {
    const db = makeDb();
    runMigration239(db);

    const holder = handleById(db, 'agent-holder-8');
    expect(holder.startsWith('space-manager-migrated-')).toBe(true);
    expect(handleById(db, 'space-lh-agent:coordinator:space-8')).toBe('renamed-prelock');
    expect(rowById(db, 'space-lh-agent:coordinator:space-8').display_name).toBe('Space Manager');

    const repo = new SpaceLongHorizonAgentRepository(db);
    const healed = repo.ensureCoordinator('space-8');
    expect(healed.id).toBe('space-lh-agent:coordinator:space-8');
    expect(healed.handle).toBe('space-manager');
    db.close();
  });

  test('relocates archived space-manager holders so they stay restorable', () => {
    const db = makeDb();
    runMigration239(db);

    expect(handleById(db, 'agent-coord-6')).toBe('space-manager');
    const relocated = handleById(db, 'agent-archived-6');
    expect(relocated.startsWith('space-manager-migrated-')).toBe(true);
    expect(relocated).not.toBe('space-manager');
    expect(() =>
      db
        .prepare(`UPDATE space_long_horizon_agents SET status = 'active' WHERE id = ?`)
        .run('agent-archived-6')
    ).not.toThrow();
    db.close();
  });

  test('relocates archived duplicate coordinator rows instead of renaming them', () => {
    const db = makeDb();
    runMigration239(db);

    expect(handleById(db, 'agent-coord-11')).toBe('space-manager');
    const relocated = handleById(db, 'agent-archived-coordinator-11');
    expect(relocated.startsWith('space-manager-migrated-')).toBe(true);
    expect(relocated).not.toBe('space-manager');
    expect(() =>
      db
        .prepare(`UPDATE space_long_horizon_agents SET status = 'active' WHERE id = ?`)
        .run('agent-archived-coordinator-11')
    ).not.toThrow();
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

  test('re-entry after a partial apply never relocates the deterministic manager', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, slug, created_at, updated_at)
				VALUES ('space-10', '/tmp/space-10', 'Space 10', 'space-10', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO space_long_horizon_agents (
					id, space_id, handle, display_name, template_key, status, session_id,
					instructions, created_at, updated_at
				) VALUES ('space-lh-agent:coordinator:space-10', 'space-10', 'coordinator', 'Coordinator', 'coordinator.default', 'active', 'space:chat:space-10', '', 1, 1)`
    ).run();
    runMigration239(db);
    expect(handleById(db, 'space-lh-agent:coordinator:space-10')).toBe('space-manager');

    runMigration239(db);
    runMigration239(db);

    expect(handleById(db, 'space-lh-agent:coordinator:space-10')).toBe('space-manager');
    expect(rowById(db, 'space-lh-agent:coordinator:space-10').display_name).toBe('Space Manager');
    db.close();
  });
});
