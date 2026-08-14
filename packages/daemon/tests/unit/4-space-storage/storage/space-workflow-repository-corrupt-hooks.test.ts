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
