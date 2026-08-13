import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { CustomHook, HookBinding } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('SpaceWorkflowRepository — hook bindings & custom hooks (v2)', () => {
  let db: Database;
  let repo: SpaceWorkflowRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 'sp-1', '/tmp/sp-1', 'Space', now, now);
    repo = new SpaceWorkflowRepository(db);
  });

  afterEach(() => db.close());

  const customHooks: CustomHook[] = [
    {
      id: 'audit-hook',
      requiredData: [{ key: 'pr_link', type: 'link', required: true }],
      run: { kind: 'script', interpreter: 'bash', source: 'echo hi', timeoutMs: 1000 },
    },
  ];

  const hookBindings: HookBinding[] = [
    {
      hookId: 'audit-hook',
      sourceNode: 'Coding',
      targetNode: 'Review',
      method: 'send_message',
      order: 0,
      enabled: true,
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
    },
  ];

  test('round-trips persisted hookBindings and customHooks', () => {
    const wf = repo.createWorkflow({
      spaceId: 'sp-1',
      name: 'Hooked',
      nodes: [
        { id: 'n1', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        { id: 'n2', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
      ],
      hookBindings,
      customHooks,
    });

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.hookBindings).toEqual(hookBindings);
    expect(fetched?.customHooks).toEqual(customHooks);
    // The v2 model does NOT populate a legacy `hooks` field.
    expect((fetched as unknown as { hooks?: unknown }).hooks).toBeUndefined();
  });

  test('updateWorkflow replaces hookBindings and customHooks', () => {
    const wf = repo.createWorkflow({
      spaceId: 'sp-1',
      name: 'Hooked',
      nodes: [
        { id: 'n1', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        { id: 'n2', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
      ],
      hookBindings,
      customHooks,
    });

    const nextBindings: HookBinding[] = [
      {
        hookId: 'pr_ready',
        sourceNode: 'Review',
        targetNode: 'Coding',
        method: 'send_message',
        order: 0,
        enabled: true,
        authorizedCallers: [{ sourceNode: 'Review' }],
      },
    ];

    const updated = repo.updateWorkflow(wf.id, {
      hookBindings: nextBindings,
      customHooks: [],
    });
    expect(updated?.hookBindings?.map((b) => b.hookId)).toEqual(['pr_ready']);
    // Empty customHooks array is persisted as null (the repository drops empty
    // arrays), so the field is undefined on read-back.
    expect(updated?.customHooks).toBeUndefined();
  });

  test('nulls/empty arrays clear the columns', () => {
    const wf = repo.createWorkflow({
      spaceId: 'sp-1',
      name: 'Hooked',
      nodes: [
        { id: 'n1', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        { id: 'n2', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
      ],
      hookBindings,
      customHooks,
    });

    const cleared = repo.updateWorkflow(wf.id, { hookBindings: null, customHooks: null });
    expect(cleared?.hookBindings).toBeUndefined();
    expect(cleared?.customHooks).toBeUndefined();
  });
});
