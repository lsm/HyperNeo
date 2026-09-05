import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { migrateLegacyLongHorizonAgentData } from '../../../../src/lib/space/agents/legacy-long-horizon-migration.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { runMigration155 } from '../../../../src/storage/schema/migrations.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { createLongHorizonAgentTables } from '../../../../src/storage/schema/long-horizon-agents.ts';
import {
  createLegacySpaceAgentTables,
  createSpaceAgentSchema,
  insertSpace,
} from '../../helpers/space-agent-schema.ts';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.exec(`DROP INDEX IF EXISTS idx_space_lh_agent_goals_one_owner`);
  createLegacySpaceAgentTables(db);
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
  test('backfills legacy agents, copies rows, and reports missing-agent skips', () => {
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

    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO space_agent_goal_assignments (space_id, agent_id, goal_id, created_at)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`
    ).run(
      'space-a',
      'shared-agent',
      'goal-a',
      100,
      'space-a',
      'worker-only',
      'goal-a',
      101,
      'space-a',
      'missing-agent',
      'goal-a',
      102
    );
    db.prepare(
      `INSERT INTO space_agent_forge_scope_assignments (space_id, agent_id, scope_id, created_at)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`
    ).run(
      'space-a',
      'shared-agent',
      'scope-a',
      200,
      'space-a',
      'worker-only',
      'scope-a',
      201,
      'space-a',
      'missing-agent',
      'scope-a',
      202
    );
    db.prepare(
      `INSERT INTO space_agent_reminders (id, space_id, agent_id, message, remind_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?), (?, ?, ?, ?, ?, 'active', ?, ?), (?, ?, ?, ?, ?, 'active', ?, ?)`
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
      261,
      'reminder-missing',
      'space-a',
      'missing-agent',
      'Check missing',
      302,
      252,
      262
    );
    db.exec('PRAGMA foreign_keys = ON');

    const report = migrateLegacyLongHorizonAgentData(db);

    expect(report).toEqual({
      backfilledAgents: 1,
      copiedGoals: 2,
      skippedGoals: 1,
      copiedForgeScopes: 2,
      skippedForgeScopes: 1,
      copiedReminders: 2,
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
    expect(repo.getById('worker-only')).toEqual(
      expect.objectContaining({
        id: 'worker-only',
        templateKey: 'migration.legacy_space_agent',
      })
    );
    expect(repo.listGoals('worker-only')).toEqual([
      expect.objectContaining({ agentId: 'worker-only', goalId: 'goal-a' }),
    ]);
    expect(repo.listForgeScopes('worker-only')).toEqual([
      expect.objectContaining({ agentId: 'worker-only', scopeId: 'scope-a' }),
    ]);
    expect(repo.listReminders('worker-only')).toEqual([
      expect.objectContaining({ id: 'reminder-worker', title: 'Check worker' }),
    ]);
    expect(repo.getById('missing-agent')).toBeNull();
    db.close();
  });

  test('schema migration runs only once so deleted canonical rows stay deleted', () => {
    const db = makeDb();
    seedSpace(db, 'space-a');
    seedWorker(db, 'worker-only', 'space-a');
    seedGoal(db, 'goal-a', 'space-a');

    db.prepare(
      `INSERT INTO space_agent_goal_assignments (space_id, agent_id, goal_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).run('space-a', 'worker-only', 'goal-a', 100);

    db.prepare(`DELETE FROM migration_markers WHERE key = ?`).run(
      'm154_legacy_long_horizon_agent_data'
    );
    runMigration155(db);

    const repo = new SpaceLongHorizonAgentRepository(db);
    expect(repo.listGoals('worker-only')).toEqual([
      expect.objectContaining({ agentId: 'worker-only', goalId: 'goal-a' }),
    ]);

    repo.deleteGoalAssignment('worker-only', 'goal-a');
    expect(repo.listGoals('worker-only')).toEqual([]);

    runMigration155(db);

    expect(repo.listGoals('worker-only')).toEqual([]);
    db.close();
  });
});

describe('legacy long-horizon migration — same-id overlay mapping', () => {
  function makeOverlayDb(): BunDatabase {
    const db = new BunDatabase(':memory:');
    createSpaceAgentSchema(db);
    createLongHorizonAgentTables(db);
    db.exec(`
      CREATE TABLE space_goals (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE evolution_scopes (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        objective TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    return db;
  }

  function seedOverlayWorker(
    db: BunDatabase,
    id: string,
    spaceId: string,
    overrides: Record<string, unknown> = {}
  ): void {
    db.prepare(
      `INSERT INTO space_agents (id, space_id, name, handle, status, tools, custom_prompt,
       system_prompt, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      spaceId,
      overrides.name ?? id,
      overrides.handle ?? null,
      overrides.status ?? 'active',
      overrides.tools ?? '[]',
      overrides.customPrompt ?? null,
      overrides.systemPrompt ?? '',
      overrides.model ?? null,
      100,
      100
    );
  }

  function seedLegacyReminder(db: BunDatabase, agentId: string, spaceId: string): void {
    db.prepare(
      `INSERT INTO space_agent_reminders (id, space_id, agent_id, message, remind_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
    ).run(`rem-${agentId}`, spaceId, agentId, `Check ${agentId}`, 300, 250, 250);
  }

  function seedLegacyGoal(db: BunDatabase, agentId: string, spaceId: string): void {
    db.prepare(
      `INSERT INTO space_goals (id, space_id, title, description, created_at, updated_at)
       VALUES (?, ?, ?, '', 1, 1)`
    ).run(`goal-${agentId}`, spaceId, `Goal ${agentId}`);
    db.prepare(
      `INSERT INTO space_agent_goal_assignments (space_id, agent_id, goal_id, created_at)
       VALUES (?, ?, ?, 1)`
    ).run(spaceId, agentId, `goal-${agentId}`);
  }

  function seedLegacyScope(db: BunDatabase, agentId: string, spaceId: string): void {
    db.prepare(
      `INSERT INTO evolution_scopes (id, space_id, kind, name, objective, created_at, updated_at)
       VALUES (?, ?, 'custom', ?, 'Track scope', 1, 1)`
    ).run(`scope-${agentId}`, spaceId, `Scope ${agentId}`);
    db.prepare(
      `INSERT INTO space_agent_forge_scope_assignments (space_id, agent_id, scope_id, created_at)
       VALUES (?, ?, ?, 1)`
    ).run(spaceId, agentId, `scope-${agentId}`);
  }

  test('maps worker rows to same-id LHA rows with collision-suffixed handles', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    insertSpace(db, 'space-b');
    const repo = new SpaceLongHorizonAgentRepository(db);
    repo.create({
      id: 'lh-holder',
      spaceId: 'space-a',
      handle: 'researcher',
      displayName: 'Holder',
    });
    repo.create({
      id: 'lh-arch',
      spaceId: 'space-a',
      handle: 'planner',
      displayName: 'Archived Holder',
      status: 'archived',
    });
    repo.create({ id: 'lh-other', spaceId: 'space-b', handle: 'scribe', displayName: 'Other' });

    seedOverlayWorker(db, 'w-collide', 'space-a', {
      name: 'Researcher',
      handle: 'researcher',
      status: 'paused',
      customPrompt: 'Custom prompt',
      tools: '["bash","read"]',
      model: 'm1',
    });
    seedOverlayWorker(db, 'w-plain', 'space-a', {
      name: 'Planner',
      handle: 'planner',
      systemPrompt: 'Sys prompt',
    });
    seedOverlayWorker(db, 'w-cross', 'space-a', { name: 'Scribe', handle: 'scribe' });
    seedOverlayWorker(db, 'w-skip', 'space-a', { name: 'NoLegacy' });
    seedLegacyReminder(db, 'w-collide', 'space-a');
    seedLegacyGoal(db, 'w-plain', 'space-a');
    seedLegacyScope(db, 'w-cross', 'space-a');

    const report = migrateLegacyLongHorizonAgentData(db);

    expect(report.backfilledAgents).toBe(3);
    expect(report.copiedGoals).toBe(1);
    expect(report.copiedForgeScopes).toBe(1);
    expect(report.copiedReminders).toBe(1);
    expect(repo.getById('w-collide')).toEqual(
      expect.objectContaining({
        id: 'w-collide',
        handle: 'researcher-w-collide',
        displayName: 'Researcher',
        status: 'paused',
        instructions: 'Custom prompt',
        model: 'm1',
        templateKey: 'migration.legacy_space_agent',
        toolPermissions: { tools: ['bash', 'read'] },
      })
    );
    expect(repo.getById('w-plain')).toEqual(
      expect.objectContaining({
        handle: 'planner',
        status: 'active',
        instructions: 'Sys prompt',
        toolPermissions: {},
      })
    );
    expect(repo.getById('w-cross')).toEqual(
      expect.objectContaining({ handle: 'scribe', displayName: 'Scribe' })
    );
    expect(repo.getById('w-skip')).toBeNull();
    db.close();
  });
});
