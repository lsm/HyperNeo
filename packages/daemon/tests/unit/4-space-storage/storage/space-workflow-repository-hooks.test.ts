import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('SpaceWorkflowRepository — hooks', () => {
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

  test('round-trips persisted workflow hook config while preserving legacy gates', () => {
    const wf = repo.createWorkflow({
      spaceId: 'sp-1',
      name: 'Hooked',
      nodes: [
        { id: 'n1', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        { id: 'n2', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
      ],
      gates: [
        {
          id: 'legacy-gate',
          fields: [
            { name: 'ok', type: 'boolean', writers: ['Coding'], check: { op: '==', value: true } },
          ],
          resetOnCycle: false,
        },
      ],
      hooks: [
        {
          id: 'hook-1',
          enabled: true,
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          validator: { kind: 'script', interpreter: 'bash', source: 'echo \'{"type":"allow"}\'' },
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
          retry: { maxAttempts: 2, delayMs: 1000 },
        },
      ],
    });

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.hooks).toEqual(wf.hooks);
    expect(fetched?.gates?.[0].id).toBe('legacy-gate');

    const updated = repo.updateWorkflow(wf.id, {
      hooks: [
        {
          id: 'hook-2',
          enabled: true,
          sourceNode: 'Review',
          method: 'save_artifact',
          validator: { kind: 'script', interpreter: 'bash', source: 'echo \'{"type":"allow"}\'' },
          authorizedCallers: [{ sourceNode: 'Review' }],
        },
      ],
    });
    expect(updated?.hooks?.map((hook) => hook.id)).toEqual(['hook-2']);
    expect(updated?.gates?.[0].id).toBe('legacy-gate');
  });
});
