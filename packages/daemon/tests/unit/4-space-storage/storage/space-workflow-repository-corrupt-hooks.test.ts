/**
 * SpaceWorkflowRepository — corrupt hook-columns fail closed.
 *
 * A non-null `hook_bindings`/`custom_hooks` value that cannot decode (bad
 * JSON or a non-array) must NOT load as "no hooks": TaskAgentManager would
 * construct no engine and every protected action would run ungated. The
 * repository loads such a workflow with a fail-closed marker binding whose
 * hook id is never registered, so the engine blocks every hookable action
 * with a diagnosable id.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import { CORRUPT_HOOK_BINDINGS_HOOK_ID } from '../../../../src/lib/space/hook-reserved-ids.ts';

describe('SpaceWorkflowRepository — corrupt hook columns', () => {
  let db: Database;
  let repo: SpaceWorkflowRepository;
  const spaceId = 'sp-1';

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run(spaceId, spaceId, '/ws/x', 'Test Space', now, now);
    repo = new SpaceWorkflowRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function corruptColumn(column: 'hook_bindings' | 'custom_hooks', value: string): void {
    db.prepare(`UPDATE space_workflows SET ${column} = ? WHERE id = ?`).run(
      value,
      db.prepare('SELECT id FROM space_workflows LIMIT 1').get()?.id
    );
  }

  test('malformed JSON in hook_bindings loads a fail-closed marker', () => {
    repo.createWorkflow({ spaceId, name: 'WF', nodes: [{ name: 'Only', agentId: 'a1' }] });
    corruptColumn('hook_bindings', '{"not":"an array"');
    const wf = repo.getWorkflow(
      db.prepare('SELECT id FROM space_workflows LIMIT 1').get()?.id as string
    );
    expect(wf?.hookBindings).toBeDefined();
    // Every (node × method) marker binding blocks fail-closed on an id that
    // is never registered.
    expect(wf?.hookBindings?.length).toBeGreaterThan(0);
    expect(wf?.hookBindings?.every((b) => b.hookId === CORRUPT_HOOK_BINDINGS_HOOK_ID)).toBe(true);
    // Whole-node callers, every hook method, all enabled.
    expect(
      wf?.hookBindings?.every(
        (b) =>
          b.enabled &&
          b.authorizedCallers?.some((c) => c.sourceNode === b.sourceNode && !c.agentSlots)
      )
    ).toBe(true);
    expect(new Set(wf?.hookBindings?.map((b) => b.method)).size).toBe(6);
  });

  test('valid JSON of the wrong shape (non-array) also fails closed', () => {
    repo.createWorkflow({ spaceId, name: 'WF', nodes: [{ name: 'Only', agentId: 'a1' }] });
    corruptColumn('custom_hooks', '{}');
    const wf = repo.getWorkflow(
      db.prepare('SELECT id FROM space_workflows LIMIT 1').get()?.id as string
    );
    expect(wf?.hookBindings?.[0]?.hookId).toBe(CORRUPT_HOOK_BINDINGS_HOOK_ID);
  });

  test('a valid array with malformed entries fails closed (not silently filtered)', () => {
    // '[{}]' is a syntactically valid array whose single entry lacks every
    // required field: resolveMatchingBindings treats missing `enabled` as
    // false and would silently filter it, loading a "valid" binding list
    // that gates nothing. The element-shape validation must route the row
    // through the fail-closed marker instead.
    repo.createWorkflow({ spaceId, name: 'WF', nodes: [{ name: 'Only', agentId: 'a1' }] });
    corruptColumn('hook_bindings', '[{}]');
    const wf = repo.getWorkflow(
      db.prepare('SELECT id FROM space_workflows LIMIT 1').get()?.id as string
    );
    expect(wf?.hookBindings?.[0]?.hookId).toBe(CORRUPT_HOOK_BINDINGS_HOOK_ID);
  });

  test("a typo'd method or shapeless caller fails closed (not silently unmatched)", () => {
    // A binding with method "send_messag" or authorizedCallers [{}] loads as
    // "valid" shape but NEVER matches in resolveMatchingBindings — silently
    // ungated. Both must route through the marker.
    repo.createWorkflow({ spaceId, name: 'WF', nodes: [{ name: 'Only', agentId: 'a1' }] });
    corruptColumn(
      'hook_bindings',
      '[{"hookId":"pr_ready","sourceNode":"Only","method":"send_messag","enabled":true}]'
    );
    let wf = repo.getWorkflow(
      db.prepare('SELECT id FROM space_workflows LIMIT 1').get()?.id as string
    );
    expect(wf?.hookBindings?.[0]?.hookId).toBe(CORRUPT_HOOK_BINDINGS_HOOK_ID);

    corruptColumn(
      'hook_bindings',
      '[{"hookId":"pr_ready","sourceNode":"Only","method":"send_message","enabled":true,"authorizedCallers":[{}]}]'
    );
    wf = repo.getWorkflow(db.prepare('SELECT id FROM space_workflows LIMIT 1').get()?.id as string);
    expect(wf?.hookBindings?.[0]?.hookId).toBe(CORRUPT_HOOK_BINDINGS_HOOK_ID);
  });

  test('an omitted/empty caller list or blank slot fails closed', async () => {
    // [] passes a bare every() vacuously and an omitted list is undefined —
    // both load "valid" but can never authorize a caller, so the runtime
    // ignores the binding entirely (ungated). A whitespace-only slot can
    // never match either.
    repo.createWorkflow({ spaceId, name: 'WF', nodes: [{ name: 'Only', agentId: 'a1' }] });
    for (const bad of [
      '[{"hookId":"pr_ready","sourceNode":"Only","method":"send_message","enabled":true}]',
      '[{"hookId":"pr_ready","sourceNode":"Only","method":"send_message","enabled":true,"authorizedCallers":[]}]',
      '[{"hookId":"pr_ready","sourceNode":"Only","method":"send_message","enabled":true,"authorizedCallers":[{"sourceNode":"Only","agentSlots":["   "]}]}]',
      // Non-empty callers naming only a DIFFERENT node: shape-valid but can
      // never authorize the acting node — the resolver filters it (ungated).
      '[{"hookId":"pr_ready","sourceNode":"Only","method":"send_message","enabled":true,"authorizedCallers":[{"sourceNode":"Elsewhere"}]}]',
      // targetNode on a non-routed method / absent on send_message: the
      // resolver rejects target-bearing non-send_message bindings and needs
      // a target for send_message — both load "valid" but gate nothing.
      '[{"hookId":"gate","sourceNode":"Only","method":"mark_complete","targetNode":"Review","enabled":true,"authorizedCallers":[{"sourceNode":"Only"}]}]',
      '[{"hookId":"gate","sourceNode":"Only","method":"send_message","enabled":true,"authorizedCallers":[{"sourceNode":"Only"}]}]',
    ]) {
      corruptColumn('hook_bindings', bad);
      const wf = repo.getWorkflow(
        db.prepare('SELECT id FROM space_workflows LIMIT 1').get()?.id as string
      );
      expect(wf?.hookBindings?.[0]?.hookId).toBe(CORRUPT_HOOK_BINDINGS_HOOK_ID);
    }
  });

  test('a malformed custom hook entry fails closed', () => {
    repo.createWorkflow({ spaceId, name: 'WF', nodes: [{ name: 'Only', agentId: 'a1' }] });
    corruptColumn('custom_hooks', '[{"id":"x"}]');
    const wf = repo.getWorkflow(
      db.prepare('SELECT id FROM space_workflows LIMIT 1').get()?.id as string
    );
    expect(wf?.hookBindings?.[0]?.hookId).toBe(CORRUPT_HOOK_BINDINGS_HOOK_ID);
  });

  test('null and empty-string columns still load as no hooks (intentional absence)', () => {
    repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'a1' }],
    });
    corruptColumn('hook_bindings', '');
    const wf = repo.getWorkflow(
      db.prepare('SELECT id FROM space_workflows LIMIT 1').get()?.id as string
    );
    // No marker — an intentionally hook-less workflow stays hook-less.
    expect(wf?.hookBindings).toBeUndefined();
  });

  test('valid bindings still round-trip unchanged', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'a1' }],
      hookBindings: [
        {
          hookId: 'pr_ready',
          sourceNode: 'Only',
          // targetNode is REQUIRED for send_message (the runtime validator's
          // routed-method rule this decoder mirrors).
          targetNode: 'Only',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Only' }],
        },
      ],
    });
    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.hookBindings?.[0]?.hookId).toBe('pr_ready');
  });
});
