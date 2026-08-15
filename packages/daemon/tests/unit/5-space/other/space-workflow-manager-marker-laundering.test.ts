/**
 * SpaceWorkflowManager — corrupt-marker laundering (round 80).
 *
 * The synthetic __corrupt_hook_bindings__ marker is repository-level
 * fail-closed STATE. updateWorkflow must never PERSIST it: an ordinary
 * editor save round-trips existing bindings verbatim, and marker bindings
 * written as real JSON decode cleanly into a permanently unresolvable hook
 * set no validation can ever flag again.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import { CORRUPT_HOOK_BINDINGS_HOOK_ID } from '../../../../src/lib/space/hook-reserved-ids.ts';

describe('SpaceWorkflowManager — corrupt-marker laundering', () => {
  let db: Database;
  let repo: SpaceWorkflowRepository;
  let manager: SpaceWorkflowManager;
  const spaceId = 'sp-1';

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, name, workspace_path, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run(spaceId, spaceId, 'Space', '/ws/x', now, now);
    repo = new SpaceWorkflowRepository(db);
    manager = new SpaceWorkflowManager(repo);
  });

  afterEach(() => db.close());

  function markerBinding(): {
    hookId: string;
    sourceNode: string;
    method: string;
    order: number;
    enabled: boolean;
    authorizedCallers: Array<{ sourceNode: string }>;
  } {
    return {
      hookId: CORRUPT_HOOK_BINDINGS_HOOK_ID,
      sourceNode: 'Only',
      method: 'send_message',
      order: 0,
      enabled: true,
      authorizedCallers: [{ sourceNode: 'Only' }],
    };
  }

  test('an editor save carrying the marker strips it before persisting', () => {
    const wf = manager.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      hookBindings: [
        {
          hookId: 'pr_ready',
          sourceNode: 'Only',
          targetNode: 'Only',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Only' }],
        },
      ],
    });
    // Simulate the visual editor round-tripping a marker-loaded workflow's
    // bindings verbatim (real binding + the synthetic marker).
    manager.updateWorkflow(wf.id, {
      hookBindings: [
        markerBinding(),
        {
          hookId: 'pr_ready',
          sourceNode: 'Only',
          targetNode: 'Only',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Only' }],
        },
      ],
    });
    const persisted = repo.getWorkflow(wf.id);
    expect(persisted?.hookBindings?.some((b) => b.hookId === CORRUPT_HOOK_BINDINGS_HOOK_ID)).toBe(
      false
    );
    expect(persisted?.hookBindings?.[0]?.hookId).toBe('pr_ready');
  });

  test('a marker-ONLY save is refused (round 82: no silent gate drop)', () => {
    const wf = manager.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      hookBindings: [
        {
          hookId: 'pr_ready',
          sourceNode: 'Only',
          targetNode: 'Only',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Only' }],
        },
      ],
    });
    // The visual editor round-trips the loaded marker bindings verbatim —
    // a marker-only payload must REFUSE (stripping to empty would convert
    // the fail-closed corrupt workflow into a valid hook-less one).
    expect(() => manager.updateWorkflow(wf.id, { hookBindings: [markerBinding()] })).toThrow(
      /corrupt and currently fails closed/
    );
    // The prior valid bindings are untouched.
    const persisted = repo.getWorkflow(wf.id);
    expect(persisted?.hookBindings?.[0]?.hookId).toBe('pr_ready');
  });

  test('a hook-unrelated edit on a marker-loaded workflow leaves the corrupt column untouched', () => {
    const wf = manager.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    // Corrupt the column directly — the repository loads the marker.
    db.prepare(`UPDATE space_workflows SET hook_bindings = ? WHERE id = ?`).run(
      '[{"hookId":"x","sourceNode":"Only","method":"send_message","enabled":true}]',
      wf.id
    );
    const updated = manager.updateWorkflow(wf.id, { description: 'unrelated edit' });
    expect(updated?.description).toBe('unrelated edit');
    // The corrupt column is NOT rewritten as marker JSON — it stays as the
    // raw corrupt value, so the marker reloads (fail-closed persists) and
    // the corruption remains detectable.
    const raw = db.prepare(`SELECT hook_bindings FROM space_workflows WHERE id = ?`).get(wf.id) as {
      hook_bindings: string;
    };
    expect(raw.hook_bindings).not.toContain(CORRUPT_HOOK_BINDINGS_HOOK_ID);
  });
});

describe('legacyHookIds — validator-id derivation (round 82)', () => {
  test('the VALIDATOR id is the gate identity, not the legacy instance id', async () => {
    const { legacyHookIds, legacyHookCoverage } = await import(
      '../../../../src/lib/space/legacy-hook-coverage.ts'
    );
    // The pre-cutover Coding shape: instance id 'code-pr-ready', validator
    // id 'pr_ready' — coverage must key on the validator id (what the v2
    // binding recreates).
    const legacy = [{ id: 'code-pr-ready', validator: { id: 'pr_ready' } }];
    expect(legacyHookIds(legacy)).toEqual(['pr_ready']);
    expect(
      legacyHookCoverage(legacy, [
        { hookId: 'pr_ready', sourceNode: 'C', method: 'send_message', order: 0, enabled: true },
      ]).complete
    ).toBe(true);
    expect(
      legacyHookCoverage(legacy, [
        {
          hookId: 'code-pr-ready',
          sourceNode: 'C',
          method: 'send_message',
          order: 0,
          enabled: true,
        },
      ]).complete
    ).toBe(false);
    // Legacy script hooks (no validator): the instance id IS the identity.
    expect(legacyHookIds([{ id: 'my_script_hook' }])).toEqual(['my_script_hook']);
    // String validator form tolerated.
    expect(legacyHookIds([{ id: 'x', validator: 'pr_ready' }])).toEqual(['pr_ready']);
  });
});

describe('SpaceWorkflowManager — legacy migration completeness (round 81)', () => {
  let db: InstanceType<typeof import('../../../../src/storage/sqlite-compat').Database>;
  let manager: InstanceType<
    typeof import('../../../../src/lib/space/managers/space-workflow-manager.ts').SpaceWorkflowManager
  >;
  const spaceId = 'sp-1';

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, name, workspace_path, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run(spaceId, spaceId, 'Space', '/ws/x', now, now);
    const repo = new SpaceWorkflowRepository(db);
    manager = new SpaceWorkflowManager(repo);
  });

  afterEach(() => db.close());

  function seedLegacyWorkflow(): string {
    const wf = manager.createWorkflow({
      spaceId,
      name: 'Legacy WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    // Fresh schemas have no legacy `hooks` column (m197 dropped it) — add
    // it back to simulate a pre-cutover row.
    db.exec(`ALTER TABLE space_workflows ADD COLUMN hooks TEXT`);
    db.prepare(`UPDATE space_workflows SET hooks = ? WHERE id = ?`).run(
      '[{"id":"pr_ready"},{"id":"review_posted"}]',
      wf.id
    );
    return wf.id;
  }

  function bindingFor(hookId: string) {
    return {
      hookId,
      sourceNode: 'Only',
      targetNode: 'Only',
      method: 'send_message' as const,
      order: 0,
      enabled: true,
      authorizedCallers: [{ sourceNode: 'Only' }],
    };
  }

  test('a caller-supplied clearLegacyHooks flag is never honored (round 84)', () => {
    const id = seedLegacyWorkflow();
    // Direct RPC-shaped payload: {id, clearLegacyHooks: true} with NO
    // hookBindings — the coverage check must still gate (the flag is
    // manager-internal; the manager resets it before its branch).
    manager.updateWorkflow(id, {
      clearLegacyHooks: true,
      description: 'attempted strip',
    } as never);
    const raw = db.prepare(`SELECT hooks FROM space_workflows WHERE id = ?`).get(id) as {
      hooks: string | null;
    };
    expect(raw.hooks).toContain('pr_ready');
  });

  test('a PARTIAL binding set is refused with the missing legacy ids', () => {
    const id = seedLegacyWorkflow();
    expect(() => manager.updateWorkflow(id, { hookBindings: [bindingFor('pr_ready')] })).toThrow(
      /missing v2 bindings for: review_posted/
    );
    // The legacy column is untouched (fail-closed persists).
    const raw = db.prepare(`SELECT hooks FROM space_workflows WHERE id = ?`).get(id) as {
      hooks: string;
    };
    expect(raw.hooks).toContain('review_posted');
  });

  test('two placements of one validator id need TWO bindings (round 85)', () => {
    // Legacy workflows may place the same validator on two routes; v2
    // forbids one hook id on multiple bindings, so a single pr_ready
    // binding cannot cover both placements — the workflow stays
    // fail-closed rather than silently dropping the second route's gate.
    const id = seedLegacyWorkflow();
    // Two placements of pr_ready + one of review_posted.
    db.prepare(`UPDATE space_workflows SET hooks = ? WHERE id = ?`).run(
      '[{"id":"a1","validator":{"id":"pr_ready"}},{"id":"a2","validator":{"id":"pr_ready"}},{"id":"x","validator":{"id":"review_posted"}}]',
      id
    );
    // One binding per id: pr_ready has 1 binding for 2 placements.
    expect(() =>
      manager.updateWorkflow(id, {
        hookBindings: [bindingFor('pr_ready'), bindingFor('review_posted')],
      })
    ).toThrow(/missing v2 bindings for: pr_ready/);
    // Legacy column untouched.
    const raw = db.prepare(`SELECT hooks FROM space_workflows WHERE id = ?`).get(id) as {
      hooks: string;
    };
    expect(raw.hooks).toContain('a2');
  });

  test('coverage matches the placement ROUTE, not just the id (round 87)', () => {
    // Legacy pr_ready gates Coding → Review; a pr_ready binding on a
    // DIFFERENT target satisfies an id-only count while the real route
    // stays ungated (and the update would clear the legacy definition).
    const id = seedLegacyWorkflow();
    db.prepare(`UPDATE space_workflows SET hooks = ? WHERE id = ?`).run(
      '[{"id":"pr_ready","targetNode":"Review"}]',
      id
    );
    expect(() =>
      manager.updateWorkflow(id, {
        hookBindings: [
          {
            hookId: 'pr_ready',
            sourceNode: 'Only',
            targetNode: 'Elsewhere',
            method: 'send_message',
            order: 0,
            enabled: true,
            authorizedCallers: [{ sourceNode: 'Only' }],
          },
        ],
      })
    ).toThrow(/missing v2 bindings for: pr_ready/);
    // Same id+target, DIFFERENT method: also uncovered.
    expect(() =>
      manager.updateWorkflow(id, {
        hookBindings: [
          {
            hookId: 'pr_ready',
            sourceNode: 'Only',
            method: 'mark_complete',
            order: 0,
            enabled: true,
            authorizedCallers: [{ sourceNode: 'Only' }],
          },
        ],
      })
    ).toThrow(/missing v2 bindings for: pr_ready/);
  });

  test('a REPLACEMENT binding list must itself cover the legacy ids (round 82)', () => {
    // hookBindings replaces wholesale: an update supplying only hook B while
    // the row's existing bindings covered hook A must REFUSE — the union
    // check previously passed and the update dropped A from both
    // representations.
    const id = seedLegacyWorkflow();
    // Pre-existing complete coverage.
    manager.updateWorkflow(id, {
      hookBindings: [bindingFor('pr_ready'), bindingFor('review_posted')],
    });
    // The legacy column was cleared by that update; re-arm it to exercise
    // the replacement path.
    db.prepare(`UPDATE space_workflows SET hooks = ? WHERE id = ?`).run(
      '[{"id":"pr_ready"},{"id":"review_posted"}]',
      id
    );
    expect(() =>
      manager.updateWorkflow(id, { hookBindings: [bindingFor('review_posted')] })
    ).toThrow(/missing v2 bindings for: pr_ready/);
  });

  test('complete coverage clears the legacy column in the SAME update', () => {
    const id = seedLegacyWorkflow();
    manager.updateWorkflow(id, {
      hookBindings: [bindingFor('pr_ready'), bindingFor('review_posted')],
    });
    const raw = db
      .prepare(`SELECT hooks, hook_bindings FROM space_workflows WHERE id = ?`)
      .get(id) as {
      hooks: string | null;
      hook_bindings: string;
    };
    expect(raw.hooks).toBeNull();
    expect(JSON.parse(raw.hook_bindings)).toHaveLength(2);
  });
});
