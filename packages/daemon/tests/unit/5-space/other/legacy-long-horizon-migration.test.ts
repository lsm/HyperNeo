import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { migrateLegacyLongHorizonAgentData } from '../../../../src/lib/space/agents/legacy-long-horizon-migration.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpace(db: BunDatabase, id: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(id, `/tmp/${id}`, id, id, Date.now(), Date.now());
}

function seedWorker(db: BunDatabase, id: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, handle, status, description, model, tools,
     system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', '', null, '[]', '', ?, ?)`
  ).run(id, spaceId, id, id, Date.now(), Date.now());
}

function seedGoal(db: BunDatabase, id: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_goals (id, space_id, title, description, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?)`
  ).run(id, spaceId, id, Date.now(), Date.now());
}

function seedScope(db: BunDatabase, id: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO evolution_scopes (id, space_id, kind, name, objective, created_at, updated_at)
     VALUES (?, ?, 'custom', ?, 'Track scope', ?, ?)`
  ).run(id, spaceId, id, Date.now(), Date.now());
}

describe('legacy long-horizon migration', () => {
  test('copies rows with matching long-horizon agents and reports worker-only skips', () => {
    const db = makeDb();
    seedSpace(db, 'space-a');
    seedWorker(db, 'shared-agent', 'space-a');
    seedWorker(db, 'worker-only', 'space-a');
    seedGoal(db, 'goal-a', 'space-a');
    seedScope(db, 'scope-a', 'space-a');
    const repo = new SpaceLongHorizonAgentRepository(db);
    repo.create({
      id: 'shared-agent',
      spaceId: 'space-a',
      handle: 'shared-agent',
      displayName: 'Shared Agent',
    });

    db.prepare(
      `INSERT INTO space_agent_goal_assignments (space_id, agent_id, goal_id, created_at)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?)`
    ).run('space-a', 'shared-agent', 'goal-a', 100, 'space-a', 'worker-only', 'goal-a', 101);
    db.prepare(
      `INSERT INTO space_agent_forge_scope_assignments (space_id, agent_id, scope_id, created_at)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?)`
    ).run('space-a', 'shared-agent', 'scope-a', 200, 'space-a', 'worker-only', 'scope-a', 201);
    db.prepare(
      `INSERT INTO space_agent_reminders (id, space_id, agent_id, message, remind_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?), (?, ?, ?, ?, ?, 'active', ?, ?)`
    ).run(
      'reminder-shared',
      'space-a',
      'shared-agent',
      'Check shared',
      300,
      250,
      260,
      'reminder-worker',
      'space-a',
      'worker-only',
      'Check worker',
      301,
      251,
      261
    );

    const report = migrateLegacyLongHorizonAgentData(db);

    expect(report).toEqual({
      copiedGoals: 1,
      skippedGoals: 1,
      copiedForgeScopes: 1,
      skippedForgeScopes: 1,
      copiedReminders: 1,
      skippedReminders: 1,
    });
    expect(repo.listGoals('shared-agent')).toEqual([
      expect.objectContaining({ agentId: 'shared-agent', goalId: 'goal-a' }),
    ]);
    expect(repo.listForgeScopes('shared-agent')).toEqual([
      expect.objectContaining({ agentId: 'shared-agent', scopeId: 'scope-a' }),
    ]);
    expect(repo.listReminders('shared-agent')).toEqual([
      expect.objectContaining({
        id: 'reminder-shared',
        title: 'Check shared',
        triggerType: 'at',
        runAt: 300,
        nextRunAt: 300,
      }),
    ]);
    expect(repo.listGoals('worker-only')).toEqual([]);
    expect(repo.listForgeScopes('worker-only')).toEqual([]);
    expect(repo.listReminders('worker-only')).toEqual([]);
    db.close();
  });
});
