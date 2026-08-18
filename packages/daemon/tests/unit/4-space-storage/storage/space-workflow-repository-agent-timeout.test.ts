import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('SpaceWorkflowRepository — WorkflowNodeAgent.timeoutMs round-trip', () => {
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

  test('createWorkflow persists per-slot timeoutMs and getWorkflow reads it back', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF With Timeout',
      nodes: [
        {
          name: 'Coding',
          agents: [
            { agentId: 'agent-1', name: 'coder', timeoutMs: 600_000 },
            { agentId: 'agent-2', name: 'reviewer' },
          ],
        },
      ],
    });

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched).not.toBeNull();
    const node = fetched!.nodes[0];
    expect(node.agents).toHaveLength(2);
    expect(node.agents[0]).toMatchObject({ name: 'coder', timeoutMs: 600_000 });
    expect(node.agents[1].timeoutMs).toBeUndefined();
  });

  test('omitted timeoutMs stays undefined (no implicit defaulting at the storage layer)', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF Without Timeout',
      nodes: [
        {
          name: 'Coding',
          agents: [{ agentId: 'agent-1', name: 'coder' }],
        },
      ],
    });

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.nodes[0].agents[0].timeoutMs).toBeUndefined();
  });

  test('updateWorkflow node replacement preserves the new timeoutMs', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [
        {
          name: 'Coding',
          agents: [{ agentId: 'agent-1', name: 'coder', timeoutMs: 300_000 }],
        },
      ],
    });

    const updated = repo.updateWorkflow(wf.id, {
      nodes: [
        {
          id: wf.nodes[0].id,
          name: 'Coding',
          agents: [{ agentId: 'agent-1', name: 'coder', timeoutMs: 900_000 }],
        },
      ],
    });
    expect(updated?.nodes[0].agents[0].timeoutMs).toBe(900_000);

    const refetched = repo.getWorkflow(wf.id);
    expect(refetched?.nodes[0].agents[0].timeoutMs).toBe(900_000);
  });

  test('listWorkflows returns timeoutMs for every workflow row', () => {
    repo.createWorkflow({
      spaceId,
      name: 'WF-A',
      nodes: [
        {
          name: 'Coding',
          agents: [{ agentId: 'agent-1', name: 'coder', timeoutMs: 600_000 }],
        },
      ],
    });
    repo.createWorkflow({
      spaceId,
      name: 'WF-B',
      nodes: [
        {
          name: 'Coding',
          agents: [{ agentId: 'agent-1', name: 'coder' }],
        },
      ],
    });

    const list = repo.listWorkflows(spaceId);
    const wfA = list.find((w) => w.name === 'WF-A');
    const wfB = list.find((w) => w.name === 'WF-B');
    expect(wfA?.nodes[0].agents[0].timeoutMs).toBe(600_000);
    expect(wfB?.nodes[0].agents[0].timeoutMs).toBeUndefined();
  });
});
