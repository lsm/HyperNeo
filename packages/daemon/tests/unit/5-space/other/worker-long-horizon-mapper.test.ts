import { describe, expect, test } from 'bun:test';
import type { SettingSource, SpaceLongHorizonAgent, ThinkingLevel } from '@hyperneo/shared';
import { migrateLegacyLongHorizonAgentData } from '../../../../src/lib/space/agents/legacy-long-horizon-migration.ts';
import {
  longHorizonAgentToWorkerView,
  type WorkerAgentRowSource,
  workerAgentToLongHorizonParams,
} from '../../../../src/lib/space/agents/worker-long-horizon-mapper.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { createLongHorizonAgentTables } from '../../../../src/storage/schema/long-horizon-agents.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat.ts';
import { createSpaceAgentSchema, insertSpace } from '../../helpers/space-agent-schema.ts';

interface WorkerSeed {
  id: string;
  spaceId: string;
  name: string;
  handle: string | null;
  status: string;
  description: string;
  model: string | null;
  thinkingLevel: string | null;
  provider: string | null;
  customPrompt: string | null;
  systemPrompt: string;
  instructions: string | null;
  tools: string;
  settingSources: string | null;
  createdAt: number;
}

function makeOverlayDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  createSpaceAgentSchema(db);
  createLongHorizonAgentTables(db);
  db.exec(`
      CREATE TABLE space_agent_goal_assignments (
        space_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, goal_id)
      )
    `);
  db.exec(`
      CREATE TABLE space_agent_forge_scope_assignments (
        space_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, scope_id)
      )
    `);
  db.exec(`
      CREATE TABLE space_agent_reminders (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        message TEXT NOT NULL,
        remind_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
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

function seedWorker(
  db: BunDatabase,
  seed: Partial<WorkerSeed> & { id: string; spaceId: string }
): void {
  const full: WorkerSeed = {
    id: seed.id,
    spaceId: seed.spaceId,
    name: seed.name ?? seed.id,
    handle: seed.handle ?? null,
    status: seed.status ?? 'active',
    description: seed.description ?? '',
    model: seed.model ?? null,
    thinkingLevel: seed.thinkingLevel ?? null,
    provider: seed.provider ?? null,
    customPrompt: seed.customPrompt ?? null,
    systemPrompt: seed.systemPrompt ?? '',
    instructions: seed.instructions ?? null,
    tools: seed.tools ?? '[]',
    settingSources: seed.settingSources ?? null,
    createdAt: seed.createdAt ?? 100,
  };
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, handle, status, description, model,
     thinking_level, provider, custom_prompt, system_prompt, instructions, tools,
     setting_sources, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    full.id,
    full.spaceId,
    full.name,
    full.handle,
    full.status,
    full.description,
    full.model,
    full.thinkingLevel,
    full.provider,
    full.customPrompt,
    full.systemPrompt,
    full.instructions,
    full.tools,
    full.settingSources,
    full.createdAt,
    200
  );
}

function seedLegacyReminder(db: BunDatabase, agentId: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agent_reminders (id, space_id, agent_id, message, remind_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(`rem-${agentId}`, spaceId, agentId, `Check ${agentId}`, 300, 250, 250);
}

function rowSource(
  seed: Partial<WorkerSeed> & { id: string; spaceId: string }
): WorkerAgentRowSource {
  const full: WorkerSeed = {
    name: seed.name ?? seed.id,
    handle: seed.handle ?? null,
    status: seed.status ?? 'active',
    description: seed.description ?? '',
    model: seed.model ?? null,
    thinkingLevel: seed.thinkingLevel ?? null,
    provider: seed.provider ?? null,
    customPrompt: seed.customPrompt ?? null,
    systemPrompt: seed.systemPrompt ?? '',
    instructions: seed.instructions ?? null,
    tools: seed.tools ?? '[]',
    settingSources: seed.settingSources ?? null,
    createdAt: seed.createdAt ?? 100,
    ...seed,
  } as WorkerSeed;
  const tools =
    full.tools === '' || full.tools === '[]' ? [] : (JSON.parse(full.tools) as string[]);
  return {
    id: full.id,
    spaceId: full.spaceId,
    name: full.name,
    handle: full.handle,
    status: full.status,
    description: full.description,
    model: full.model,
    thinkingLevel: full.thinkingLevel as ThinkingLevel | null,
    provider: full.provider,
    customPrompt: full.customPrompt,
    instructions: full.instructions,
    systemPrompt: full.systemPrompt,
    tools,
    settingSources: full.settingSources
      ? (JSON.parse(full.settingSources) as SettingSource[])
      : null,
    createdAt: full.createdAt,
  };
}

function occupiedHandles(db: BunDatabase, spaceId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT handle FROM space_long_horizon_agents WHERE space_id = ? AND status != 'archived'`
    )
    .all(spaceId) as Array<{ handle: string }>;
  return new Set(rows.map((row) => row.handle));
}

describe('workerAgentToLongHorizonParams — m155 SQL equivalence', () => {
  test('pure mapper output matches the backfill SQL row field-for-field on fixture rows', () => {
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

    const seeds: Array<Partial<WorkerSeed> & { id: string; spaceId: string }> = [
      {
        id: 'w-collide',
        spaceId: 'space-a',
        name: 'Researcher',
        handle: 'researcher',
        status: 'paused',
        model: 'm1',
        thinkingLevel: 'think8k',
        provider: 'provider-x',
        customPrompt: 'Custom prompt',
        tools: '["bash","read"]',
        settingSources: '["user","project"]',
        createdAt: 111,
      },
      { id: 'w-nullhandle', spaceId: 'space-a', name: 'Planner', handle: null },
      {
        id: 'w-sys',
        spaceId: 'space-a',
        name: 'Sys Only',
        handle: 'sys-only',
        customPrompt: null,
        systemPrompt: 'Sys prompt',
      },
      {
        id: 'w-archived',
        spaceId: 'space-a',
        name: 'Retired',
        handle: 'retired',
        status: 'archived',
        instructions: null,
      },
      {
        id: 'w-cross',
        spaceId: 'space-a',
        name: 'Scribe',
        handle: 'scribe',
        tools: '[]',
      },
    ];
    for (const seed of seeds) {
      seedWorker(db, seed);
      seedLegacyReminder(db, seed.id, seed.spaceId);
    }

    const handlesBySpace = new Map<string, Set<string>>([
      ['space-a', occupiedHandles(db, 'space-a')],
      ['space-b', occupiedHandles(db, 'space-b')],
    ]);
    const startTs = Date.now();
    const report = migrateLegacyLongHorizonAgentData(db);
    expect(report.backfilledAgents).toBe(seeds.length);

    for (const seed of seeds) {
      const params = workerAgentToLongHorizonParams(rowSource(seed), {
        occupiedHandles: handlesBySpace.get(seed.spaceId) ?? new Set<string>(),
        now: startTs,
      });
      const row = repo.getById(seed.id);
      expect(row).toEqual(
        expect.objectContaining({
          id: params.id,
          spaceId: params.spaceId,
          handle: params.handle,
          displayName: params.displayName,
          templateKey: params.templateKey,
          status: params.status,
          sessionId: params.sessionId,
          instructions: params.instructions,
          autonomyLevel: params.autonomyLevel,
          model: params.model,
          thinkingLevel: params.thinkingLevel,
          provider: params.provider,
          settingSources: params.settingSources,
          toolPermissions: params.toolPermissions,
          createdAt: params.createdAt,
        })
      );
      expect(row?.updatedAt).toBeGreaterThanOrEqual(startTs);
      expect(params.updatedAt).toBe(startTs);
    }

    expect(repo.getById('w-collide')?.handle).toBe('researcher-w-collide');
    expect(repo.getById('w-nullhandle')?.handle).toBe('Planner');
    expect(repo.getById('w-sys')?.instructions).toBe('Sys prompt');
    expect(repo.getById('w-archived')?.status).toBe('archived');
    expect(repo.getById('w-cross')?.handle).toBe('scribe');
    db.close();
  });
});

describe('workerAgentToLongHorizonParams — typed extensions beyond m155', () => {
  const NOW = 12345;

  test('instructions term sits between custom_prompt and system_prompt in the fallback chain', () => {
    const params = workerAgentToLongHorizonParams(
      rowSource({
        id: 'w-1',
        spaceId: 'space-a',
        instructions: 'Inline prompt',
        systemPrompt: 'Sys',
      }),
      { occupiedHandles: new Set<string>(), now: NOW }
    );

    expect(params.instructions).toBe('Inline prompt');
  });

  test('empty-string custom_prompt wins over later terms, matching SQL COALESCE', () => {
    const params = workerAgentToLongHorizonParams(
      rowSource({
        id: 'w-1',
        spaceId: 'space-a',
        customPrompt: '',
        instructions: 'Inline prompt',
        systemPrompt: 'Sys',
      }),
      { occupiedHandles: new Set<string>(), now: NOW }
    );

    expect(params.instructions).toBe('');
  });

  test('carries description and modelPool for the unified table (D-DM-2/D-DM-3)', () => {
    const withPool = workerAgentToLongHorizonParams(
      {
        ...rowSource({ id: 'w-1', spaceId: 'space-a', description: 'Runs things' }),
        modelPool: [{ model: 'm1', provider: 'provider-x', maxConcurrent: 2, weight: 1 }],
      },
      { occupiedHandles: new Set<string>(), now: NOW }
    );

    expect(withPool.description).toBe('Runs things');
    expect(withPool.modelPool).toEqual([
      { model: 'm1', provider: 'provider-x', maxConcurrent: 2, weight: 1 },
    ]);

    const withoutExtras = workerAgentToLongHorizonParams(
      rowSource({ id: 'w-2', spaceId: 'space-a' }),
      {
        occupiedHandles: new Set<string>(),
        now: NOW,
      }
    );

    expect(withoutExtras.description).toBeUndefined();
    expect(withoutExtras.modelPool).toBeUndefined();
  });

  test('missing createdAt falls back to the caller-provided now stamp', () => {
    const params = workerAgentToLongHorizonParams(
      { ...rowSource({ id: 'w-1', spaceId: 'space-a' }), createdAt: null },
      { occupiedHandles: new Set<string>(), now: NOW }
    );

    expect(params.createdAt).toBe(NOW);
    expect(params.updatedAt).toBe(NOW);
  });

  test('noncanonical statuses normalize to active like the SQL CASE ELSE', () => {
    for (const status of ['', 'unknown'] as const) {
      const params = workerAgentToLongHorizonParams(
        { ...rowSource({ id: 'w-1', spaceId: 'space-a' }), status },
        { occupiedHandles: new Set<string>(), now: NOW }
      );

      expect(params.status).toBe('active');
    }
  });

  test('collision suffix appends the agent id to the base handle (D-DM-4)', () => {
    const params = workerAgentToLongHorizonParams(
      rowSource({ id: 'w-1', spaceId: 'space-a', handle: 'researcher', name: 'Researcher' }),
      {
        occupiedHandles: new Set<string>(['researcher']),
        now: NOW,
      }
    );

    expect(params.handle).toBe('researcher-w-1');
    expect(params.displayName).toBe('Researcher');
  });

  test('re-suffixed handles stay clear when both the base and first suffix are occupied', () => {
    const params = workerAgentToLongHorizonParams(
      rowSource({ id: 'w-1', spaceId: 'space-a', handle: 'researcher', name: 'Researcher' }),
      { occupiedHandles: new Set<string>(['researcher', 'researcher-w-1']), now: NOW }
    );

    expect(params.handle).toBe('researcher-w-1-w-1');
  });

  test('batch callers reserve each chosen handle so converted rows cannot collide', () => {
    const reserved = new Set<string>(['researcher']);
    const first = workerAgentToLongHorizonParams(
      rowSource({ id: 'w-1', spaceId: 'space-a', handle: 'researcher' }),
      {
        occupiedHandles: reserved,
        now: NOW,
      }
    );
    reserved.add(first.handle);
    const second = workerAgentToLongHorizonParams(
      rowSource({ id: 'w-2', spaceId: 'space-a', handle: 'researcher' }),
      { occupiedHandles: reserved, now: NOW }
    );
    reserved.add(second.handle);

    expect(first.handle).toBe('researcher-w-1');
    expect(second.handle).toBe('researcher-w-2');
  });

  test('name and id fill the handle and displayName fallbacks in COALESCE order', () => {
    const params = workerAgentToLongHorizonParams(
      { ...rowSource({ id: 'w-9', spaceId: 'space-a', name: 'Named' }), handle: null },
      { occupiedHandles: new Set<string>(), now: NOW }
    );

    expect(params.handle).toBe('Named');
    expect(params.displayName).toBe('Named');
  });
});

describe('longHorizonAgentToWorkerView — unified row to worker view (U3a)', () => {
  function longHorizonAgent(overrides: Partial<SpaceLongHorizonAgent> = {}): SpaceLongHorizonAgent {
    return {
      id: 'lh-1',
      spaceId: 'space-a',
      handle: 'researcher',
      displayName: 'Researcher',
      templateKey: 'migration.legacy_space_agent',
      status: 'active',
      sessionId: null,
      instructions: 'Investigate thoroughly',
      autonomyLevel: null,
      model: 'kimi-for-coding',
      thinkingLevel: null,
      provider: 'kimi',
      settingSources: null,
      toolPermissions: { tools: ['Bash', 'Read'] },
      description: 'Does research',
      modelPool: [{ model: 'kimi-for-coding', maxConcurrent: 2, weight: 1 }],
      createdAt: 10,
      updatedAt: 20,
      ...overrides,
    };
  }

  test('maps unified fields onto the SpaceWorkerAgent shape', () => {
    const view = longHorizonAgentToWorkerView(longHorizonAgent());

    expect(view.id).toBe('lh-1');
    expect(view.spaceId).toBe('space-a');
    expect(view.name).toBe('Researcher');
    expect(view.handle).toBe('researcher');
    expect(view.status).toBe('active');
    expect(view.description).toBe('Does research');
    expect(view.model).toBe('kimi-for-coding');
    expect(view.provider).toBe('kimi');
    expect(view.customPrompt).toBe('Investigate thoroughly');
    expect(view.tools).toEqual(['Bash', 'Read']);
    expect(view.templateName).toBe('migration.legacy_space_agent');
    expect(view.templateHash).toBeNull();
    expect(view.modelPool).toEqual([{ model: 'kimi-for-coding', maxConcurrent: 2, weight: 1 }]);
    expect(view.createdAt).toBe(10);
    expect(view.updatedAt).toBe(20);
  });

  test('empty tool permissions read as the inherit-all undefined tools profile', () => {
    const view = longHorizonAgentToWorkerView(longHorizonAgent({ toolPermissions: {} }));
    expect(view.tools).toBeUndefined();
  });

  test('non-string tool entries are filtered out of the view', () => {
    const view = longHorizonAgentToWorkerView(
      longHorizonAgent({ toolPermissions: { tools: ['Bash', 7, null] } })
    );
    expect(view.tools).toEqual(['Bash']);
  });

  test('non-worker statuses collapse onto the worker status set', () => {
    expect(longHorizonAgentToWorkerView(longHorizonAgent({ status: 'paused' })).status).toBe(
      'paused'
    );
    expect(longHorizonAgentToWorkerView(longHorizonAgent({ status: 'disabled' })).status).toBe(
      'paused'
    );
    expect(longHorizonAgentToWorkerView(longHorizonAgent({ status: 'archived' })).status).toBe(
      'archived'
    );
  });
});
