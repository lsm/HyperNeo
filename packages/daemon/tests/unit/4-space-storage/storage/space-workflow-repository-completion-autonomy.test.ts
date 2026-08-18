import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('SpaceWorkflowRepository — completionAutonomyLevel', () => {
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

  test('createWorkflow defaults completionAutonomyLevel to 3 when omitted', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'Missing Level',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    expect(wf.completionAutonomyLevel).toBe(3);
    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.completionAutonomyLevel).toBe(3);
  });

  test('createWorkflow stores and reads back completionAutonomyLevel', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      completionAutonomyLevel: 4,
    });
    expect(wf.completionAutonomyLevel).toBe(4);

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.completionAutonomyLevel).toBe(4);
  });

  test('updateWorkflow raises/lowers completionAutonomyLevel', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      completionAutonomyLevel: 2,
    });

    const raised = repo.updateWorkflow(wf.id, { completionAutonomyLevel: 5 });
    expect(raised?.completionAutonomyLevel).toBe(5);

    const lowered = repo.updateWorkflow(wf.id, { completionAutonomyLevel: 1 });
    expect(lowered?.completionAutonomyLevel).toBe(1);
  });

  test('updateWorkflow leaves completionAutonomyLevel alone when not provided', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      completionAutonomyLevel: 3,
    });

    const updated = repo.updateWorkflow(wf.id, { name: 'Renamed' });
    expect(updated?.name).toBe('Renamed');
    expect(updated?.completionAutonomyLevel).toBe(3);
  });

  test('listWorkflows returns completionAutonomyLevel for every row', () => {
    repo.createWorkflow({
      spaceId,
      name: 'A',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      completionAutonomyLevel: 1,
    });
    repo.createWorkflow({
      spaceId,
      name: 'B',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      completionAutonomyLevel: 5,
    });
    const all = repo.listWorkflows(spaceId);
    const byName = Object.fromEntries(all.map((w) => [w.name, w.completionAutonomyLevel]));
    expect(byName).toEqual({ A: 1, B: 5 });
  });
});
