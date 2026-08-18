import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('SpaceWorkflowRepository — handle', () => {
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

  test('createWorkflow stores and reads back a handle', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF with handle',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      handle: 'coding-with-qa',
    });
    expect(wf.handle).toBe('coding-with-qa');

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.handle).toBe('coding-with-qa');
  });

  test('createWorkflow without handle leaves field undefined on read', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF no handle',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    expect(wf.handle).toBeUndefined();

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.handle).toBeUndefined();
  });

  test('updateWorkflow can add a handle to an existing workflow', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    expect(wf.handle).toBeUndefined();

    const updated = repo.updateWorkflow(wf.id, { handle: 'review-flow' });
    expect(updated?.handle).toBe('review-flow');

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.handle).toBe('review-flow');
  });

  test('updateWorkflow can replace an existing handle', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      handle: 'old-handle',
    });
    expect(wf.handle).toBe('old-handle');

    const updated = repo.updateWorkflow(wf.id, { handle: 'new-handle' });
    expect(updated?.handle).toBe('new-handle');
  });

  test('updateWorkflow with handle: null clears the handle', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      handle: 'to-clear',
    });
    expect(wf.handle).toBe('to-clear');

    const cleared = repo.updateWorkflow(wf.id, { handle: null });
    expect(cleared?.handle).toBeUndefined();

    const fetched = repo.getWorkflow(wf.id);
    expect(fetched?.handle).toBeUndefined();
  });

  test('updateWorkflow with handle: undefined leaves existing handle alone', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      handle: 'keep-me',
    });

    const renamed = repo.updateWorkflow(wf.id, { name: 'Renamed' });
    expect(renamed?.name).toBe('Renamed');
    expect(renamed?.handle).toBe('keep-me');
  });

  test('listWorkflows surfaces handle on every row where it is set', () => {
    repo.createWorkflow({
      spaceId,
      name: 'A',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      handle: 'handle-a',
    });
    repo.createWorkflow({
      spaceId,
      name: 'B',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });

    const all = repo.listWorkflows(spaceId);
    const byName = Object.fromEntries(all.map((w) => [w.name, w.handle]));
    expect(byName.A).toBe('handle-a');
    expect(byName.B).toBeUndefined();
  });

  test('getWorkflowByHandle returns the workflow when handle exists', () => {
    const wf = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      handle: 'find-me',
    });

    const found = repo.getWorkflowByHandle(spaceId, 'find-me');
    expect(found).not.toBeNull();
    expect(found?.id).toBe(wf.id);
    expect(found?.handle).toBe('find-me');
  });

  test('getWorkflowByHandle returns null when handle does not exist', () => {
    const found = repo.getWorkflowByHandle(spaceId, 'missing');
    expect(found).toBeNull();
  });

  test('getWorkflowByHandle returns null for handle in a different space', () => {
    const otherSpaceId = 'sp-2';
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run(otherSpaceId, otherSpaceId, '/ws/y', 'Other Space', now, now);

    repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      handle: 'space-1-handle',
    });

    const found = repo.getWorkflowByHandle(otherSpaceId, 'space-1-handle');
    expect(found).toBeNull();
  });

  test('getHandlesForSpace returns all handles for a space', () => {
    repo.createWorkflow({
      spaceId,
      name: 'A',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      handle: 'handle-a',
    });
    repo.createWorkflow({
      spaceId,
      name: 'B',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      handle: 'handle-b',
    });
    repo.createWorkflow({
      spaceId,
      name: 'C',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });

    const handles = repo.getHandlesForSpace(spaceId);
    expect(handles.sort()).toEqual(['handle-a', 'handle-b']);
  });

  test('getHandlesForSpace returns empty array when no handles exist', () => {
    repo.createWorkflow({
      spaceId,
      name: 'A',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });

    const handles = repo.getHandlesForSpace(spaceId);
    expect(handles).toEqual([]);
  });

  test('partial unique index prevents duplicate handles in the same space', () => {
    repo.createWorkflow({
      spaceId,
      name: 'First',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      handle: 'duplicate',
    });

    expect(() =>
      repo.createWorkflow({
        spaceId,
        name: 'Second',
        nodes: [{ name: 'Only', agentId: 'agent-1' }],
        handle: 'duplicate',
      })
    ).toThrow();
  });

  test('same handle is allowed in different spaces', () => {
    const otherSpaceId = 'sp-2';
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run(otherSpaceId, otherSpaceId, '/ws/y', 'Other Space', now, now);

    const wf1 = repo.createWorkflow({
      spaceId,
      name: 'First',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      handle: 'shared-handle',
    });
    const wf2 = repo.createWorkflow({
      spaceId: otherSpaceId,
      name: 'Second',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
      handle: 'shared-handle',
    });

    expect(wf1.handle).toBe('shared-handle');
    expect(wf2.handle).toBe('shared-handle');
  });

  test('multiple workflows without handle do not violate the partial unique index', () => {
    const wf1 = repo.createWorkflow({
      spaceId,
      name: 'First',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    const wf2 = repo.createWorkflow({
      spaceId,
      name: 'Second',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });

    expect(wf1.handle).toBeUndefined();
    expect(wf2.handle).toBeUndefined();
  });
});
