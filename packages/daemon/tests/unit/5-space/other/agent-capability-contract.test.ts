import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { describe, expect, test } from 'bun:test';
import type { Space, SpaceTask } from '@hyperneo/shared';
import { DENIABLE_TOOLS } from '@hyperneo/shared';
import { requireAgentFamily } from '../../../../src/lib/space/agents/agent-family-resolver';
import {
  createCustomAgentInit,
  resolveAgentInit,
} from '../../../../src/lib/space/agents/custom-agent';
import { migrateLegacyLongHorizonAgentData } from '../../../../src/lib/space/agents/legacy-long-horizon-migration';
import { PRESET_AGENT_TOOLS } from '../../../../src/lib/space/agents/seed-agents';
import { deriveWorkerDisallowedTools } from '../../../../src/lib/space/agents/tool-policy';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { runMigrations } from '../../../../src/storage/schema/index';

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

function seedWorker(db: BunDatabase, id: string, spaceId: string, toolsJson = '[]'): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, handle, status, description, model, tools,
     system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', '', null, ?, '', ?, ?)`
  ).run(id, spaceId, id, id, toolsJson, Date.now(), Date.now());
}

function seedGoal(db: BunDatabase, id: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_goals (id, space_id, title, description, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?)`
  ).run(id, spaceId, id, Date.now(), Date.now());
}

function makeRepos(db: BunDatabase) {
  return {
    spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
    longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
  };
}

describe('deriveWorkerDisallowedTools — shared tool-policy resolver', () => {
  test('empty / null / undefined profile is permissive: no built-ins denied', () => {
    expect(deriveWorkerDisallowedTools([])).toEqual([]);
    expect(deriveWorkerDisallowedTools(null)).toEqual([]);
    expect(deriveWorkerDisallowedTools(undefined)).toEqual([]);
  });

  test('a profile that omits every deniable tool denies exactly the shared DENIABLE_TOOLS set', () => {
    expect(deriveWorkerDisallowedTools(['Read', 'Grep', 'Glob'])).toEqual([...DENIABLE_TOOLS]);
  });

  test('a profile listing every deniable tool denies nothing', () => {
    expect(deriveWorkerDisallowedTools([...DENIABLE_TOOLS, 'Read'])).toEqual([]);
  });

  test('only deniable tools absent from the profile are denied; present ones pass through', () => {
    expect(deriveWorkerDisallowedTools(['Read', 'Bash', 'Grep'])).toEqual([
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
    ]);
  });

  test('non-deniable profile entries do not affect the denial set', () => {
    expect(deriveWorkerDisallowedTools(['Read', 'Grep', 'Task', 'Skill', 'ToolSearch'])).toEqual([
      ...DENIABLE_TOOLS,
    ]);
  });

  test('a permissive (empty) profile denies nothing — not even auxMutators', () => {
    expect(deriveWorkerDisallowedTools([], { auxMutators: ['Workflow'] })).toEqual([]);
    expect(deriveWorkerDisallowedTools(null, { auxMutators: ['Workflow'] })).toEqual([]);
  });

  test('auxMutators are denied in addition to the deniable built-ins, built-ins first', () => {
    const denied = deriveWorkerDisallowedTools(['Read'], {
      auxMutators: ['Workflow', 'CronCreate'],
    });
    expect(denied.slice(0, DENIABLE_TOOLS.length)).toEqual([...DENIABLE_TOOLS]);
    expect(denied.slice(DENIABLE_TOOLS.length)).toEqual(['Workflow', 'CronCreate']);
  });
});

describe('effective runtime capability vs declared profile (worker presets)', () => {
  function effectiveDeniableTools(profile: readonly string[] | null | undefined): string[] {
    const denied = new Set(deriveWorkerDisallowedTools(profile));
    return DENIABLE_TOOLS.filter((t) => !denied.has(t));
  }

  test('Coder declares an empty profile yet inherits every deniable tool at runtime', () => {
    const profile = PRESET_AGENT_TOOLS.coder;
    expect(profile).toEqual([]);
    expect(effectiveDeniableTools(profile)).toEqual([...DENIABLE_TOOLS]);
  });

  test('every permissive preset inherits the full deniable set at runtime', () => {
    const permissive = {
      coder: PRESET_AGENT_TOOLS.coder,
      general: PRESET_AGENT_TOOLS.general,
      planner: PRESET_AGENT_TOOLS.planner,
      research: PRESET_AGENT_TOOLS.research,
    };
    for (const [name, profile] of Object.entries(permissive)) {
      expect(profile, `${name} profile`).toEqual([]);
      expect(effectiveDeniableTools(profile), `${name} runtime`).toEqual([...DENIABLE_TOOLS]);
    }
  });

  test('Reviewer keeps Bash but denies write/edit deniable tools (restrained review role)', () => {
    const effective = new Set(effectiveDeniableTools(PRESET_AGENT_TOOLS.reviewer));
    expect(effective.has('Bash')).toBe(true);
    expect(effective.has('Write')).toBe(false);
    expect(effective.has('Edit')).toBe(false);
    expect(effective.has('MultiEdit')).toBe(false);
    expect(effective.has('NotebookEdit')).toBe(false);
  });

  test('QA keeps Bash, denies the write/edit deniable tools', () => {
    const effective = new Set(effectiveDeniableTools(PRESET_AGENT_TOOLS.qa));
    expect(effective.has('Bash')).toBe(true);
    expect(effective.has('Write')).toBe(false);
    expect(effective.has('Edit')).toBe(false);
  });

  test('capability consistency invariant holds for every preset', () => {
    for (const [name, profile] of Object.entries(PRESET_AGENT_TOOLS)) {
      const permissive = !profile || profile.length === 0;
      const listed = new Set(profile);
      const denied = new Set(deriveWorkerDisallowedTools(profile));
      for (const tool of DENIABLE_TOOLS) {
        const availableAtRuntime = !denied.has(tool);
        const intendedAvailable = permissive || listed.has(tool);
        expect({ preset: name, tool, availableAtRuntime, intendedAvailable }).toEqual({
          preset: name,
          tool,
          availableAtRuntime: intendedAvailable,
          intendedAvailable,
        });
      }
    }
  });
});

describe('shared resolver across worker and long-horizon families', () => {
  function workerInit(tools: string[]) {
    return createCustomAgentInit({
      customAgent: {
        id: 'a1',
        spaceId: 's1',
        name: 'A',
        customPrompt: null,
        tools,
        createdAt: 1,
        updatedAt: 1,
      },
      task: {
        id: 't1',
        spaceId: 's1',
        taskNumber: 1,
        title: 'T',
        description: '',
        status: 'open',
        priority: 'normal',
        dependsOn: [],
        createdAt: 1,
        updatedAt: 1,
      },
      space: {
        id: 's1',
        name: 'S',
        description: '',
        workspacePath: '/tmp',
        backgroundContext: '',
        instructions: '',
        sessionIds: [],
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      },
      sessionId: 'sess',
      workspacePath: '/tmp',
      workflowRun: null,
      workflow: null,
    });
  }

  test('the worker production path (createCustomAgentInit) delegates to the shared resolver', () => {
    const permissive = workerInit([]);
    expect(permissive.disallowedTools).toBeUndefined();
    expect(permissive.disallowedTools ?? []).toEqual(deriveWorkerDisallowedTools([]));

    const profile = ['Read', 'Bash'];
    expect(workerInit(profile).disallowedTools ?? []).toEqual(deriveWorkerDisallowedTools(profile));
  });
});

describe('legacy migrated long-horizon data resolves through both resolvers', () => {
  function backfillLegacyWorker(
    db: BunDatabase,
    workerId: string,
    spaceId: string,
    goalId: string,
    toolsJson: string
  ): void {
    seedWorker(db, workerId, spaceId, toolsJson);
    seedGoal(db, goalId, spaceId);
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO space_agent_goal_assignments (space_id, agent_id, goal_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(spaceId, workerId, goalId, 100);
    db.exec('PRAGMA foreign_keys = ON');
  }

  test('migrated permissive worker → permissive LH agent, reachable as long-horizon', () => {
    const db = makeDb();
    seedSpace(db, 'space-a');
    backfillLegacyWorker(db, 'legacy-coder', 'space-a', 'goal-a', '[]');

    migrateLegacyLongHorizonAgentData(db);

    const repos = makeRepos(db);
    const migrated = repos.longHorizonAgentRepo.getById('legacy-coder');
    expect(migrated).not.toBeNull();
    expect(migrated?.templateKey).toBe('migration.legacy_space_agent');
    expect(migrated?.toolPermissions.tools).toBeUndefined();

    expect(
      requireAgentFamily({
        spaceId: 'space-a',
        agentId: 'legacy-coder',
        expected: 'long_horizon',
        ...repos,
      }).longHorizonAgent?.id
    ).toBe('legacy-coder');

    const customTools = Array.isArray(migrated!.toolPermissions.tools)
      ? (migrated!.toolPermissions.tools as string[])
      : undefined;
    expect(deriveWorkerDisallowedTools(customTools)).toEqual([]);
    db.close();
  });

  test('migrated restrictive worker → restrictive LH agent (intent preserved)', () => {
    const db = makeDb();
    seedSpace(db, 'space-a');
    backfillLegacyWorker(
      db,
      'legacy-readonly',
      'space-a',
      'goal-b',
      JSON.stringify(['Read', 'Grep', 'Glob'])
    );

    migrateLegacyLongHorizonAgentData(db);

    const repos = makeRepos(db);
    const migrated = repos.longHorizonAgentRepo.getById('legacy-readonly');
    expect(migrated?.toolPermissions.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(deriveWorkerDisallowedTools(migrated!.toolPermissions.tools as string[])).toEqual([
      ...DENIABLE_TOOLS,
    ]);
    db.close();
  });
});

describe('additive validation: requireAgentFamily + task-scoped resolution', () => {
  function setup() {
    const db = makeDb();
    seedSpace(db, 'space-a');
    seedWorker(db, 'worker-only', 'space-a');
    const repos = makeRepos(db);
    repos.longHorizonAgentRepo.create({
      id: 'lh-only',
      spaceId: 'space-a',
      handle: 'lh-only',
      displayName: 'LH Only',
    });
    return { db, ...repos };
  }

  test('requireAgentFamily returns the long-horizon agent for a valid LH id', () => {
    const { db, ...repos } = setup();
    expect(
      requireAgentFamily({
        spaceId: 'space-a',
        agentId: 'lh-only',
        expected: 'long_horizon',
        ...repos,
      }).longHorizonAgent?.id
    ).toBe('lh-only');
    db.close();
  });

  test('requireAgentFamily throws the wrong-family error a worker id would trip', () => {
    const { db, ...repos } = setup();
    expect(() =>
      requireAgentFamily({
        spaceId: 'space-a',
        agentId: 'worker-only',
        expected: 'long_horizon',
        ...repos,
      })
    ).toThrow('Expected long-horizon agent id, got worker agent id.');
    db.close();
  });

  test('requireAgentFamily surfaces the LH-side not-found message for cross-space / missing ids', () => {
    const { db, ...repos } = setup();
    seedSpace(db, 'space-b');
    seedWorker(db, 'cross-worker', 'space-b');
    expect(() =>
      requireAgentFamily({
        spaceId: 'space-a',
        agentId: 'cross-worker',
        expected: 'long_horizon',
        ...repos,
      })
    ).toThrow('Long-horizon agent not found: cross-worker');
    expect(() =>
      requireAgentFamily({
        spaceId: 'space-a',
        agentId: 'missing',
        expected: 'long_horizon',
        ...repos,
      })
    ).toThrow('Long-horizon agent not found: missing');
    db.close();
  });

  test('resolveAgentInit includes the task id in the worker not-found error', () => {
    const { db, spaceAgentManager } = setup();
    const task: Partial<SpaceTask> = { id: 'task-42' };
    const space: Partial<Space> = { id: 'space-a' };
    expect(() =>
      resolveAgentInit({
        task: task as SpaceTask,
        space: space as Space,
        agentManager: spaceAgentManager,
        sessionId: 'sess',
        workspacePath: '/tmp',
        agentId: 'no-such-agent',
      })
    ).toThrow('Agent not found: no-such-agent (task: task-42)');
    db.close();
  });
});
