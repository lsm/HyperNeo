/**
 * Agent Capability Contract Tests
 *
 * Pins the effective runtime capability derived from a worker agent's declared
 * tool profile, against the shared `DENIABLE_TOOLS` constant that both the
 * daemon resolver (`deriveWorkerDisallowedTools`) and the web editor
 * (`SpaceAgentEditor`) import from `@hyperneo/shared`. Sharing one constant
 * means the runtime denial set and the UI's deniable toggles cannot drift apart.
 *
 * Background (the regression this guards): permissive worker presets — Coder,
 * General, Planner, Research — declare an *empty* tool profile. Because the
 * profile is a visible override and not an exhaustive SDK allowlist, the runtime
 * inherits every SDK built-in (Bash, Write, Edit, …) for those agents even
 * though the profile lists none. These tests assert the declared profile and the
 * effective runtime toolset stay consistent.
 *
 * Covered dimensions:
 *   1. deriveWorkerDisallowedTools — the shared tool-policy resolver
 *   2. effective runtime capability vs declared profile (worker presets, Coder)
 *   3. shared resolver across worker + long-horizon families
 *   4. legacy migrated long-horizon data resolves through both resolvers
 *   5. additive validation: requireAgentFamily throwing + task-scoped resolution
 *      (the non-throwing resolveAgentFamily classification is already covered by
 *      agent-family-resolver.test.ts, so this file covers only the additive paths)
 */

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

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1. deriveWorkerDisallowedTools — the shared tool-policy resolver
// ---------------------------------------------------------------------------

describe('deriveWorkerDisallowedTools — shared tool-policy resolver', () => {
  test('empty / null / undefined profile is permissive: no built-ins denied', () => {
    expect(deriveWorkerDisallowedTools([])).toEqual([]);
    expect(deriveWorkerDisallowedTools(null)).toEqual([]);
    expect(deriveWorkerDisallowedTools(undefined)).toEqual([]);
  });

  test('a profile that omits every deniable tool denies exactly the shared DENIABLE_TOOLS set', () => {
    // Cross-layer contract: the daemon resolver denies exactly the constant the
    // web editor imports for its deniable toggles. If either side diverges this
    // assertion (or the shared import) breaks.
    expect(deriveWorkerDisallowedTools(['Read', 'Grep', 'Glob'])).toEqual([...DENIABLE_TOOLS]);
  });

  test('a profile listing every deniable tool denies nothing', () => {
    expect(deriveWorkerDisallowedTools([...DENIABLE_TOOLS, 'Read'])).toEqual([]);
  });

  test('only deniable tools absent from the profile are denied; present ones pass through', () => {
    // Keeps Bash, denies Write/Edit/MultiEdit/NotebookEdit (mirrors Reviewer intent).
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
    // Permissive means permissive: the early return ignores auxMutators entirely.
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

// ---------------------------------------------------------------------------
// 2. effective runtime capability vs declared profile (worker presets)
// ---------------------------------------------------------------------------

describe('effective runtime capability vs declared profile (worker presets)', () => {
  /** Runtime effective availability for the deniable built-ins = those not denied. */
  function effectiveDeniableTools(profile: readonly string[] | null | undefined): string[] {
    const denied = new Set(deriveWorkerDisallowedTools(profile));
    return DENIABLE_TOOLS.filter((t) => !denied.has(t));
  }

  test('Coder declares an empty profile yet inherits every deniable tool at runtime', () => {
    // The permissive-inheritance contract: an empty profile denies nothing, so
    // Bash/Write/Edit/… stay available at runtime even though the profile lists
    // none — the agent is not restricted despite declaring no tools.
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
    // The Reviewer has Bash for read-only GitHub inspection and gh-CLI review
    // posting, so Bash is available — but the write/edit deniable tools are
    // denied, so it cannot modify the code under review.
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
    // For every preset + every deniable tool: the tool is available at runtime
    // iff the profile is permissive OR explicitly lists it. This is the
    // invariant that keeps a permissive (empty) profile from implying the agent
    // is restricted, and an explicit profile from granting tools it omits.
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

// ---------------------------------------------------------------------------
// 3. shared resolver across worker and long-horizon families
// ---------------------------------------------------------------------------

describe('shared resolver across worker and long-horizon families', () => {
  // Both production session-builders delegate tool resolution to the same shared
  // deriveWorkerDisallowedTools: createCustomAgentInit (worker) and
  // buildLongHorizonAgentSessionConfig (long-horizon). Rather than mirror those
  // paths locally — which cannot detect a production regression — this drives the
  // real worker path and asserts it delegates to the resolver. The real LH path
  // (buildLongHorizonAgentSessionConfig → session.config.disallowedTools) is
  // covered by space-runtime-service.test.ts ("long-horizon event sessions
  // preserve converted agent tool restrictions"), so it is not duplicated here.
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
    // Permissive profile: the resolver denies nothing, so the production init
    // omits disallowedTools entirely (the agent inherits every built-in).
    const permissive = workerInit([]);
    expect(permissive.disallowedTools).toBeUndefined();
    expect(permissive.disallowedTools ?? []).toEqual(deriveWorkerDisallowedTools([]));

    // Restrictive profile: the production output matches the resolver exactly,
    // proving the worker path uses the same shared DENIABLE_TOOLS-backed logic.
    const profile = ['Read', 'Bash'];
    expect(workerInit(profile).disallowedTools ?? []).toEqual(deriveWorkerDisallowedTools(profile));
  });
});

// ---------------------------------------------------------------------------
// 4. legacy migrated long-horizon data resolves through both resolvers
// ---------------------------------------------------------------------------

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
    // A goal assignment row is what triggers the backfill into the LH registry.
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
    // A legacy worker with an empty tool profile (the permissive Coder case).
    backfillLegacyWorker(db, 'legacy-coder', 'space-a', 'goal-a', '[]');

    migrateLegacyLongHorizonAgentData(db);

    const repos = makeRepos(db);
    const migrated = repos.longHorizonAgentRepo.getById('legacy-coder');
    expect(migrated).not.toBeNull();
    expect(migrated?.templateKey).toBe('migration.legacy_space_agent');
    // Empty original tools → migrated toolPermissions has no `tools` key → permissive.
    expect(migrated?.toolPermissions.tools).toBeUndefined();

    // Migration *copies* the worker into the LH registry (the worker row is
    // retained), so the id is now shared across both families. That reachability
    // as a long-horizon agent is what lets LH ownership/automation operations
    // apply to migrated legacy data.
    expect(
      requireAgentFamily({
        spaceId: 'space-a',
        agentId: 'legacy-coder',
        expected: 'long_horizon',
        ...repos,
      }).longHorizonAgent?.id
    ).toBe('legacy-coder');

    // And it stays permissive at runtime (the LH extraction path).
    const customTools = Array.isArray(migrated!.toolPermissions.tools)
      ? (migrated!.toolPermissions.tools as string[])
      : undefined;
    expect(deriveWorkerDisallowedTools(customTools)).toEqual([]);
    db.close();
  });

  test('migrated restrictive worker → restrictive LH agent (intent preserved)', () => {
    const db = makeDb();
    seedSpace(db, 'space-a');
    // A legacy worker with an explicit read-only tool profile.
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
    // The restrictive intent is preserved through the same shared resolver.
    expect(deriveWorkerDisallowedTools(migrated!.toolPermissions.tools as string[])).toEqual([
      ...DENIABLE_TOOLS,
    ]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 5. additive validation: requireAgentFamily throwing + task-scoped resolution
// ---------------------------------------------------------------------------

describe('additive validation: requireAgentFamily + task-scoped resolution', () => {
  // agent-family-resolver.test.ts already covers the non-throwing
  // resolveAgentFamily classifications (worker_only / long_horizon_only / shared /
  // cross_space / missing) and the worker-side "Agent not found" message. This
  // section covers only the additive throwing/guarding paths.

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
    // requireLongHorizonAgentInSpace (the LH-only ownership/automation guard
    // behind 10+ MCP ops) calls requireAgentFamily; a valid id returns, not throws.
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
    // Additive: the long-horizon-expected path produces a distinct
    // "Long-horizon agent not found: X" message (the existing test only asserts
    // the worker-expected "Agent not found: X").
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
    // Worker-side task → agent resolution. A missing agent id must surface a
    // task-scoped error so callers can correlate the failure to the task that
    // triggered the session spawn.
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
