import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('SpaceWorkflowRepository — disabled', () => {
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

  test('createWorkflow stores disabled=false by default', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF default',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    expect(wf.disabled).toBeUndefined();

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.disabled).toBeUndefined();
  });

  test('createWorkflow stores and reads back disabled=true', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF disabled',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      disabled: true,
    });
    expect(wf.disabled).toBe(true);

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.disabled).toBe(true);
  });

  test('updateWorkflow can disable an existing workflow', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    expect(wf.disabled).toBeUndefined();

    const updated = repo.updateWorkflow(wf.id, { disabled: true });
    expect(updated?.disabled).toBe(true);

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.disabled).toBe(true);
  });

  test('updateWorkflow can re-enable a disabled workflow', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      disabled: true,
    });
    expect(wf.disabled).toBe(true);

    const updated = repo.updateWorkflow(wf.id, { disabled: false });
    expect(updated?.disabled).toBeUndefined();

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.disabled).toBeUndefined();
  });

  test('updateWorkflow with disabled: null leaves the existing value alone', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      disabled: true,
    });

    const updated = repo.updateWorkflow(wf.id, { name: 'Renamed' });
    expect(updated?.name).toBe('Renamed');
    expect(updated?.disabled).toBe(true);
  });

  test('listWorkflows surfaces disabled on every row where it is set', () => {
    repo.createWorkflow({
      spaceId,
      name: 'A',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      disabled: true,
    });
    repo.createWorkflow({
      spaceId,
      name: 'B',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });

    const all = repo.listWorkflows(spaceId);
    const byName = Object.fromEntries(all.map((w) => [w.name, w.disabled]));
    expect(byName.A).toBe(true);
    expect(byName.B).toBeUndefined();
  });
});
