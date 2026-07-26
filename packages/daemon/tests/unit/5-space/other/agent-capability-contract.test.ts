/**
 * Agent Capability Contract Tests
 *
 * Pins the contract between the shared agent-family / tool-policy resolver and
 * the tool lists the UI renders for worker agents and long-horizon (LH) agents.
 *
 * Background (the regression this guards): permissive worker presets — Coder,
 * General, Planner, Research — declare an *empty* tool profile. Because the
 * profile is a visible override and not an exhaustive SDK allowlist, the runtime
 * inherits every SDK built-in (Bash, Write, Edit, …) for those agents. The UI,
 * however, derives its tool display straight from the profile (`tools.length`
 * + badges), so it rendered "0 tools" for the Coder while the runtime was fully
 * permissive — a stale, restrictive appearance despite a permissive runtime.
 *
 * These tests assert the declared profile and the *effective* runtime toolset
 * stay consistent, and that the same resolver is shared by both families.
 *
 * Covered dimensions:
 *   1. deriveWorkerDisallowedTools — the shared tool-policy resolver
 *   2. effective-vs-declared capability contract (worker presets, incl. Coder)
 *   3. shared resolver across worker + long-horizon families
 *   4. resolveAgentFamily boundary — LH-only ownership/automation guard
 *   5. legacy migrated long-horizon data resolves through both resolvers
 *   6. RPC / task-ID validation error mapping
 */

import { Database as BunDatabase } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  requireAgentFamily,
  resolveAgentFamily,
} from '../../../../src/lib/space/agents/agent-family-resolver';
import { resolveAgentInit } from '../../../../src/lib/space/agents/custom-agent';
import { migrateLegacyLongHorizonAgentData } from '../../../../src/lib/space/agents/legacy-long-horizon-migration';
import { PRESET_AGENT_TOOLS } from '../../../../src/lib/space/agents/seed-agents';
import { deriveWorkerDisallowedTools } from '../../../../src/lib/space/agents/tool-policy';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { runMigrations } from '../../../../src/storage/schema/index';

// ---------------------------------------------------------------------------
// Mutation built-ins
// ---------------------------------------------------------------------------

/**
 * The built-ins the runtime denies when a configured profile omits them.
 * Must mirror tool-policy.ts MUTATION_TOOLS and the UI's DENIABLE_TOOLS
 * (SpaceAgentEditor.tsx). Asserting a fully-omitting profile is denied exactly
 * this set pins that the two layers stay in sync.
 */
const MUTATION_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

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

  test('a profile that omits every mutation tool denies exactly the documented deniable set', () => {
    expect(deriveWorkerDisallowedTools(['Read', 'Grep', 'Glob'])).toEqual([...MUTATION_TOOLS]);
  });

  test('a profile listing every mutation tool denies nothing', () => {
    expect(deriveWorkerDisallowedTools([...MUTATION_TOOLS, 'Read'])).toEqual([]);
  });

  test('only mutation tools absent from the profile are denied; present ones pass through', () => {
    // Keeps Bash, denies Write/Edit/MultiEdit/NotebookEdit (mirrors Reviewer intent).
    expect(deriveWorkerDisallowedTools(['Read', 'Bash', 'Grep'])).toEqual([
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
    ]);
  });

  test('non-mutating profile entries do not affect the denial set', () => {
    expect(deriveWorkerDisallowedTools(['Read', 'Grep', 'Task', 'Skill', 'ToolSearch'])).toEqual([
      ...MUTATION_TOOLS,
    ]);
  });

  test('a permissive (empty) profile denies nothing — not even auxMutators', () => {
    // Permissive means permissive: the early return ignores auxMutators entirely.
    expect(deriveWorkerDisallowedTools([], { auxMutators: ['Workflow'] })).toEqual([]);
    expect(deriveWorkerDisallowedTools(null, { auxMutators: ['Workflow'] })).toEqual([]);
  });

  test('auxMutators are denied in addition to the built-in mutation tools, built-ins first', () => {
    const denied = deriveWorkerDisallowedTools(['Read'], {
      auxMutators: ['Workflow', 'CronCreate'],
    });
    expect(denied.slice(0, MUTATION_TOOLS.length)).toEqual([...MUTATION_TOOLS]);
    expect(denied.slice(MUTATION_TOOLS.length)).toEqual(['Workflow', 'CronCreate']);
  });
});

// ---------------------------------------------------------------------------
// 2. effective-vs-declared capability contract (worker presets)
// ---------------------------------------------------------------------------

describe('effective-vs-declared capability contract (worker presets)', () => {
  /**
   * Mirror of the UI tool display (SpaceWorkerAgentList.AgentCard +
   * SpaceAgentEditor.detectPreset). The UI renders the *declared* profile
   * verbatim: count = tools.length, badges = first 3 tools, "Inherited" when
   * the profile is empty.
   */
  function uiRenderedProfile(profile: readonly string[] | null | undefined) {
    const tools = profile && profile.length > 0 ? [...profile] : [];
    return {
      count: tools.length,
      badges: tools.slice(0, 3),
      preset: tools.length === 0 ? 'Inherited' : 'Custom',
    };
  }

  /** Runtime effective mutation availability = mutation built-ins not denied. */
  function effectiveMutationTools(profile: readonly string[] | null | undefined): string[] {
    const denied = new Set(deriveWorkerDisallowedTools(profile));
    return MUTATION_TOOLS.filter((t) => !denied.has(t));
  }

  const PERMISSIVE_PRESETS = {
    coder: PRESET_AGENT_TOOLS.coder,
    general: PRESET_AGENT_TOOLS.general,
    planner: PRESET_AGENT_TOOLS.planner,
    research: PRESET_AGENT_TOOLS.research,
  };

  test('Coder declares an empty profile (UI: Inherited) yet inherits every mutation tool at runtime', () => {
    const profile = PRESET_AGENT_TOOLS.coder;
    // UI shows nothing restrictive…
    expect(uiRenderedProfile(profile)).toEqual({ count: 0, badges: [], preset: 'Inherited' });
    // …but the runtime makes the full mutation set available (Bash/Write/Edit/…).
    expect(effectiveMutationTools(profile)).toEqual([...MUTATION_TOOLS]);
  });

  test('every permissive preset keeps the UI non-restrictive while the runtime stays fully capable', () => {
    for (const [name, profile] of Object.entries(PERMISSIVE_PRESETS)) {
      expect(uiRenderedProfile(profile), `${name} UI`).toEqual({
        count: 0,
        badges: [],
        preset: 'Inherited',
      });
      expect(effectiveMutationTools(profile), `${name} runtime`).toEqual([...MUTATION_TOOLS]);
    }
  });

  test('Reviewer declares an explicit profile: Bash available, write/edit tools denied', () => {
    const profile = PRESET_AGENT_TOOLS.reviewer;
    const effective = new Set(effectiveMutationTools(profile));
    expect(effective.has('Bash')).toBe(true);
    expect(effective.has('Write')).toBe(false);
    expect(effective.has('Edit')).toBe(false);
    expect(effective.has('MultiEdit')).toBe(false);
    expect(effective.has('NotebookEdit')).toBe(false);
    // UI shows the explicit (Custom) profile, consistent with the restrictive runtime.
    expect(uiRenderedProfile(profile).preset).toBe('Custom');
  });

  test('QA declares an explicit profile: Bash available, write/edit denied', () => {
    const profile = PRESET_AGENT_TOOLS.qa;
    const effective = new Set(effectiveMutationTools(profile));
    expect(effective.has('Bash')).toBe(true);
    expect(effective.has('Write')).toBe(false);
    expect(effective.has('Edit')).toBe(false);
  });

  test('capability consistency invariant holds for every preset', () => {
    // For every preset + every mutation tool: the tool is available at runtime
    // iff the profile is permissive OR explicitly lists it. This is the
    // invariant that keeps the UI's "Inherited / 0 tools" from implying the
    // agent is restricted while the runtime is permissive (and vice versa).
    for (const [name, profile] of Object.entries(PRESET_AGENT_TOOLS)) {
      const permissive = !profile || profile.length === 0;
      const listed = new Set(profile);
      const denied = new Set(deriveWorkerDisallowedTools(profile));
      for (const tool of MUTATION_TOOLS) {
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
  // createCustomAgentInit (worker) reads agent.tools; buildLongHorizonAgentSessionConfig
  // (LH) reads agent.toolPermissions.tools. Both feed the resulting array through
  // deriveWorkerDisallowedTools. These helpers mirror those two extraction paths so
  // we can assert identical inputs resolve identically regardless of family.
  function workerDisallowed(agent: { tools?: string[] | null }): string[] {
    return deriveWorkerDisallowedTools(agent.tools);
  }

  function longHorizonDisallowed(agent: { toolPermissions: { tools?: unknown } }): string[] {
    const customTools = Array.isArray(agent.toolPermissions.tools)
      ? (agent.toolPermissions.tools.filter((t) => typeof t === 'string') as string[])
      : undefined;
    return deriveWorkerDisallowedTools(customTools);
  }

  test('identical logical tool lists resolve identically for worker and LH agents', () => {
    const cases: Array<{ label: string; worker: string[] | null; lh: unknown }> = [
      { label: 'permissive (empty)', worker: [], lh: undefined },
      { label: 'permissive (null)', worker: null, lh: undefined },
      { label: 'reviewer', worker: PRESET_AGENT_TOOLS.reviewer, lh: PRESET_AGENT_TOOLS.reviewer },
      { label: 'qa', worker: PRESET_AGENT_TOOLS.qa, lh: PRESET_AGENT_TOOLS.qa },
      { label: 'custom read+bash', worker: ['Read', 'Bash'], lh: ['Read', 'Bash'] },
    ];
    for (const { label, worker, lh } of cases) {
      expect(workerDisallowed({ tools: worker }), label).toEqual(
        longHorizonDisallowed({ toolPermissions: { tools: lh } })
      );
    }
  });

  test('LH agent without toolPermissions.tools is permissive, matching a worker with no tools', () => {
    expect(longHorizonDisallowed({ toolPermissions: {} })).toEqual([]);
    expect(longHorizonDisallowed({ toolPermissions: { tools: undefined } })).toEqual([]);
    expect(workerDisallowed({ tools: [] })).toEqual([]);
  });

  test('LH agent with toolPermissions.tools resolves through the same mutation-deny rule', () => {
    // create_agent writes { tools: args.tools } for non-empty lists.
    const lhAgent = { toolPermissions: { tools: PRESET_AGENT_TOOLS.reviewer } };
    expect(longHorizonDisallowed(lhAgent)).toEqual(
      deriveWorkerDisallowedTools(PRESET_AGENT_TOOLS.reviewer)
    );
  });
});

// ---------------------------------------------------------------------------
// 4. resolveAgentFamily boundary — LH-only ownership/automation guard
// ---------------------------------------------------------------------------

describe('resolveAgentFamily boundary — LH-only ownership/automation guard', () => {
  // requireLongHorizonAgentInSpace (space-agent-tools.ts) calls requireAgentFamily
  // with expected:'long_horizon' to gate every LH-only operation: get_agent,
  // update_agent, delete_agent, list/create/update/delete subscriptions, and
  // reminders. A worker agent id must be rejected so worker agents cannot drive
  // LH-only ownership/automation, and vice versa.

  function setup() {
    const db = makeDb();
    seedSpace(db, 'space-a');
    seedWorker(db, 'worker-only', 'space-a');
    seedWorker(db, 'shared-id', 'space-a');
    const repos = makeRepos(db);
    repos.longHorizonAgentRepo.create({
      id: 'lh-only',
      spaceId: 'space-a',
      handle: 'lh-only',
      displayName: 'LH Only',
    });
    repos.longHorizonAgentRepo.create({
      id: 'shared-id',
      spaceId: 'space-a',
      handle: 'shared-id',
      displayName: 'Shared',
    });
    return { db, ...repos };
  }

  test('LH-only ops accept a long-horizon id and return the agent', () => {
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

  test('LH-only ops reject a worker id with the wrong-family error', () => {
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

  test('worker-scoped ops reject a long-horizon id with the wrong-family error', () => {
    const { db, ...repos } = setup();
    expect(() =>
      requireAgentFamily({
        spaceId: 'space-a',
        agentId: 'lh-only',
        expected: 'worker',
        ...repos,
      })
    ).toThrow('Expected worker agent id, got long-horizon agent id.');
    db.close();
  });

  test('a shared id resolves for both families', () => {
    const { db, ...repos } = setup();
    expect(
      resolveAgentFamily({
        spaceId: 'space-a',
        agentId: 'shared-id',
        expected: 'worker',
        ...repos,
      })
    ).toMatchObject({ classification: 'shared', ok: true, sharedId: true });
    expect(
      resolveAgentFamily({
        spaceId: 'space-a',
        agentId: 'shared-id',
        expected: 'long_horizon',
        ...repos,
      })
    ).toMatchObject({ classification: 'shared', ok: true });
    db.close();
  });

  test('LH-only ops reject a cross-space or missing id with a not-found error', () => {
    const { db, ...repos } = setup();
    seedSpace(db, 'space-b');
    seedWorker(db, 'other-space-worker', 'space-b');
    expect(() =>
      requireAgentFamily({
        spaceId: 'space-a',
        agentId: 'other-space-worker',
        expected: 'long_horizon',
        ...repos,
      })
    ).toThrow('Long-horizon agent not found: other-space-worker');
    expect(() =>
      requireAgentFamily({
        spaceId: 'space-a',
        agentId: 'totally-missing',
        expected: 'long_horizon',
        ...repos,
      })
    ).toThrow('Long-horizon agent not found: totally-missing');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 5. legacy migrated long-horizon data resolves through both resolvers
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

  test('migrated permissive worker → permissive LH agent, classified long-horizon', () => {
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
      resolveAgentFamily({
        spaceId: 'space-a',
        agentId: 'legacy-coder',
        expected: 'long_horizon',
        ...repos,
      })
    ).toMatchObject({ classification: 'shared', ok: true, sharedId: true });

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
      ...MUTATION_TOOLS,
    ]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 6. RPC / task-ID validation error mapping
// ---------------------------------------------------------------------------

describe('RPC / task-ID validation error mapping', () => {
  // The resolver errors are the validation contract that RPC handlers
  // (spaceLongHorizonAgent.*) and MCP tools (space-agent-tools) surface.

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

  test('cross-space and missing ids produce the "Agent not found" error shape', () => {
    const { db, ...repos } = setup();
    seedSpace(db, 'space-b');
    seedWorker(db, 'cross-worker', 'space-b');
    expect(
      resolveAgentFamily({
        spaceId: 'space-a',
        agentId: 'cross-worker',
        expected: 'worker',
        ...repos,
      }).error
    ).toBe('Agent not found: cross-worker');
    expect(
      resolveAgentFamily({
        spaceId: 'space-a',
        agentId: 'missing',
        expected: 'worker',
        ...repos,
      }).error
    ).toBe('Agent not found: missing');
    db.close();
  });

  test('worker task resolution includes the task id in the not-found error', () => {
    // resolveAgentInit (custom-agent.ts) is the worker-side task → agent resolution.
    // A missing agent id must surface a task-scoped error so callers can correlate
    // the failure back to the task that triggered the session spawn.
    const { db, spaceAgentManager } = setup();
    expect(() =>
      resolveAgentInit({
        task: { id: 'task-42' } as never,
        space: { id: 'space-a' } as never,
        agentManager: spaceAgentManager,
        sessionId: 'sess',
        workspacePath: '/tmp',
        agentId: 'no-such-agent',
      } as never)
    ).toThrow('Agent not found: no-such-agent (task: task-42)');
    db.close();
  });
});
