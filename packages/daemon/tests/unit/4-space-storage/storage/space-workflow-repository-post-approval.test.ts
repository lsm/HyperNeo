import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { PostApprovalRoute } from '@hyperneo/shared';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('SpaceWorkflowRepository — postApproval', () => {
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

  test('createWorkflow stores and reads back a PostApprovalRoute', () => {
    const route: PostApprovalRoute = {
      targetAgent: 'task-agent',
      instructions: 'Merge {{pr_url}} once CI is green.',
    };
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF with route',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      postApproval: route,
    });
    expect(wf.postApproval).toEqual(route);

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.postApproval).toEqual(route);
  });

  test('createWorkflow without postApproval leaves the field undefined on read', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF no route',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    expect(wf.postApproval).toBeUndefined();

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.postApproval).toBeUndefined();
  });

  test('updateWorkflow can add a route to an existing workflow', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    expect(wf.postApproval).toBeUndefined();

    const route: PostApprovalRoute = {
      targetAgent: 'reviewer',
      instructions: 'Final checks on {{pr_url}}.',
    };
    const updated = repo.updateWorkflow(wf.id, { postApproval: route });
    expect(updated?.postApproval).toEqual(route);

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.postApproval).toEqual(route);
  });

  test('updateWorkflow can replace an existing route', () => {
    const initial: PostApprovalRoute = {
      targetAgent: 'task-agent',
      instructions: 'Initial',
    };
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      postApproval: initial,
    });

    const replacement: PostApprovalRoute = {
      targetAgent: 'reviewer',
      instructions: 'Replaced',
    };
    const updated = repo.updateWorkflow(wf.id, { postApproval: replacement });
    expect(updated?.postApproval).toEqual(replacement);
  });

  test('updateWorkflow with postApproval: null clears the route', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      postApproval: { targetAgent: 'task-agent', instructions: 'hi' },
    });
    expect(wf.postApproval).toBeDefined();

    const cleared = repo.updateWorkflow(wf.id, { postApproval: null });
    expect(cleared?.postApproval).toBeUndefined();

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.postApproval).toBeUndefined();
  });

  test('updateWorkflow with postApproval: undefined leaves the existing route alone', () => {
    const route: PostApprovalRoute = {
      targetAgent: 'task-agent',
      instructions: 'Keep me.',
    };
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      postApproval: route,
    });

    const renamed = repo.updateWorkflow(wf.id, { name: 'Renamed' });
    expect(renamed?.name).toBe('Renamed');
    expect(renamed?.postApproval).toEqual(route);
  });

  test('listWorkflows surfaces postApproval on every row where it is set', () => {
    const withRoute: PostApprovalRoute = {
      targetAgent: 'reviewer',
      instructions: 'X',
    };
    repo.createWorkflow({
      spaceId,
      name: 'A',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      postApproval: withRoute,
    });
    repo.createWorkflow({
      spaceId,
      name: 'B',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });

    const all = repo.listWorkflows(spaceId);
    const byName = Object.fromEntries(all.map((w) => [w.name, w.postApproval]));
    expect(byName.A).toEqual(withRoute);
    expect(byName.B).toBeUndefined();
  });
});
