import { describe, expect, test } from 'bun:test';
import { computeAgentTemplateHash } from '../../../../../src/lib/space/agents/agent-template-hash.ts';
import {
  getPresetAgentTemplates,
  seedUnifiedSpaceAgents,
} from '../../../../../src/lib/space/agents/seed-agents.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { runMigration213 } from '../../../../../src/storage/schema/m213-inactivity-watchdog.ts';
import { runMigration232 } from '../../../../../src/storage/schema/m232-retire-pristine-seeded-worker-agents.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { insertSpace } from '../../../helpers/space-agent-schema.ts';
import { createSpaceTables } from '../../../helpers/space-test-db.ts';

function createDb(): {
  db: Database;
  repo: SpaceLongHorizonAgentRepository;
  idsByName: Map<string, string>;
} {
  const db = new Database(':memory:');
  createSpaceTables(db);
  insertSpace(db);
  const repo = new SpaceLongHorizonAgentRepository(db);
  const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
  const presets = new Map(getPresetAgentTemplates().map((preset) => [preset.name, preset]));
  const insertWorker = db.prepare(
    `INSERT INTO space_agents (
       id, space_id, name, handle, description, tools, custom_prompt,
       template_name, template_hash, created_at, updated_at
     ) VALUES (?, 'space-1', ?, ?, ?, ?, ?, ?, ?, 1, 1)`
  );
  for (const agent of seeded) {
    const preset = presets.get(agent.displayName);
    if (!preset) throw new Error(`Missing preset ${agent.displayName}`);
    insertWorker.run(
      agent.id,
      preset.name,
      preset.handle,
      preset.description,
      JSON.stringify(preset.tools),
      preset.customPrompt,
      preset.name,
      computeAgentTemplateHash(preset)
    );
  }
  return { db, repo, idsByName: new Map(seeded.map((agent) => [agent.displayName, agent.id])) };
}

function insertCustomNamedCoder(db: Database): void {
  db.prepare(
    `INSERT INTO space_long_horizon_agents (
       id, space_id, handle, display_name, template_key, instructions,
       tool_permissions_json, description, created_at, updated_at
     ) VALUES ('agent-custom-coder', 'space-1', 'coder-agent-custom-coder', 'Coder',
       'migration.legacy_space_agent', 'My own coder prompt', '{}', 'My own coder', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO space_agents (
       id, space_id, name, handle, description, tools, custom_prompt,
       template_name, template_hash, created_at, updated_at
     ) VALUES ('agent-custom-coder', 'space-1', 'Coder', 'coder-agent-custom-coder', 'My own coder', '[]',
       'My own coder prompt', 'Coder', ?, 1, 1)`
  ).run(
    computeAgentTemplateHash({
      name: 'Coder',
      description: 'My own coder',
      tools: [],
      customPrompt: 'My own coder prompt',
    })
  );
}

function remaining(repo: SpaceLongHorizonAgentRepository): string[] {
  return repo.listBySpaceId('space-1').map((agent) => agent.displayName);
}

describe('migration 232: retire pristine seeded worker agents', () => {
  test('deletes all six pristine worker mirrors', () => {
    const { db, repo } = createDb();

    runMigration232(db);

    expect(remaining(repo)).toEqual([]);
    db.close();
  });

  test('keeps customized and non-preset long-horizon agents', () => {
    const { db, repo, idsByName } = createDb();
    repo.update(idsByName.get('Coder')!, { instructions: 'My customized coder' });
    db.prepare(`UPDATE space_agents SET description = 'edited legacy row' WHERE id = ?`).run(
      idsByName.get('General')!
    );
    repo.create({
      spaceId: 'space-1',
      handle: 'personal',
      displayName: 'Personal',
      instructions: 'My agent',
    });

    runMigration232(db);

    expect(remaining(repo)).toEqual(['Coder', 'General', 'Personal']);
    db.close();
  });

  test('keeps mirrors customized outside the fingerprint', () => {
    const { db, repo, idsByName } = createDb();
    repo.update(idsByName.get('Coder')!, { model: 'claude-sonnet-5' });
    repo.update(idsByName.get('General')!, { handle: 'my-renamed-general' });
    repo.update(idsByName.get('Planner')!, { sessionId: 'session-1' });
    repo.update(idsByName.get('Research')!, { thinkingLevel: 'think16k' });

    runMigration232(db);

    expect(remaining(repo)).toEqual(['Coder', 'General', 'Planner', 'Research']);
    db.close();
  });

  test('keeps a user-created agent that merely shares a preset name', () => {
    const { db, repo } = createDb();
    insertCustomNamedCoder(db);

    runMigration232(db);

    expect(remaining(repo)).toEqual(['Coder']);
    db.close();
  });

  test('keeps a pristine worker still referenced by a workflow slot', () => {
    const { db, repo, idsByName } = createDb();
    db.prepare(
      `INSERT INTO space_workflows (
         id, space_id, name, created_at, updated_at
       ) VALUES ('workflow-1', 'space-1', 'Workflow', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO space_workflow_nodes (
         id, workflow_id, name, config, created_at, updated_at
       ) VALUES ('node-1', 'workflow-1', 'Node', ?, 1, 1)`
    ).run(JSON.stringify({ agents: [{ agentId: idsByName.get('Coder') }] }));

    runMigration232(db);

    expect(remaining(repo)).toEqual(['Coder']);
    db.close();
  });

  test('keeps pristine workers that own durable resources', () => {
    const { db, repo, idsByName } = createDb();
    const [coderId, generalId, plannerId, researchId] = [
      'Coder',
      'General',
      'Planner',
      'Research',
    ].map((name) => idsByName.get(name)!);
    db.prepare(
      `INSERT INTO space_goals (
         id, space_id, title, description, status, type, priority, labels, metrics,
         summary, progress, next_steps, auto_trigger_next, pending_next_run, created_at, updated_at
       ) VALUES ('goal-1', 'space-1', 'Goal', '', 'active', 'one_shot', 'normal', '[]', '{}', '', 0, '[]', 0, 0, 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO evolution_scopes (
         id, space_id, kind, name, objective, metric_definitions_json, policy_json, created_at, updated_at
       ) VALUES ('scope-1', 'space-1', 'mission', 'Scope', 'Objective', '[]', '{}', 1, 1)`
    ).run();
    repo.assignGoal(coderId, 'goal-1');
    repo.assignForgeScope(generalId, 'scope-1');
    repo.createReminder({
      spaceId: 'space-1',
      agentId: plannerId,
      title: 'Reminder',
      triggerType: 'at',
      runAt: 1,
    });
    repo.createSubscription({
      spaceId: 'space-1',
      agentId: researchId,
      source: 'github',
      topic: 'pull_request.*',
    });

    runMigration232(db);

    expect(remaining(repo)).toEqual(['Coder', 'General', 'Planner', 'Research']);
    db.close();
  });

  test('keeps pristine workers with pending inbox messages or watchdog state', () => {
    const { db, repo, idsByName } = createDb();
    runMigration213(db);
    db.prepare(
      `INSERT INTO space_agent_inbox_messages (
         id, space_id, target_agent_id, source_actor_id, message, status, expires_at, created_at
       ) VALUES ('inbox-1', 'space-1', ?, 'coordinator', 'Hello', 'pending', 2, 1)`
    ).run(idsByName.get('Coder')!);
    db.prepare(
      `INSERT INTO space_agent_inactivity_config (
         id, space_id, agent_id, enabled, config_revision, created_at, updated_at
       ) VALUES ('watchdog-1', 'space-1', ?, 1, 1, 1, 1)`
    ).run(idsByName.get('General')!);

    runMigration232(db);

    expect(remaining(repo)).toEqual(['Coder', 'General']);
    db.close();
  });
});
