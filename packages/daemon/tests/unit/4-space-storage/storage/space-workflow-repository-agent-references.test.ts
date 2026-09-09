import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('SpaceWorkflowRepository — getWorkflowsReferencingAgent', () => {
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

  test('matches the referenced agent exactly, not by id prefix', () => {
    repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-2' }],
    });

    expect(repo.getWorkflowsReferencingAgent('agent')).toHaveLength(0);
    expect(repo.getWorkflowsReferencingAgent('agent-2')).toHaveLength(1);
  });

  test('does not treat ids mentioned only in instructions as references', () => {
    repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'other-agent', instructions: 'ping agent-1' }],
    });

    expect(repo.getWorkflowsReferencingAgent('agent-1')).toHaveLength(0);
  });
});

describe('SpaceWorkflowRepository — getWorkflowsReferencingTemplate', () => {
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

  test('finds workflows whose current slot references the template key', () => {
    repo.createWorkflow({
      spaceId,
      name: 'WF One',
      nodes: [
        { name: 'Only', agents: [{ agentId: '', name: 'Worker', templateKey: 'reviewer.custom' }] },
      ],
    });
    repo.createWorkflow({
      spaceId,
      name: 'WF Two',
      nodes: [
        { name: 'Only', agents: [{ agentId: '', name: 'Worker', templateKey: 'qa.custom' }] },
      ],
    });

    const referencing = repo.getWorkflowsReferencingTemplate('reviewer.custom');
    expect(referencing).toHaveLength(1);
    expect(referencing[0]?.name).toBe('WF One');
  });

  test('matches the template key exactly, not by prefix', () => {
    repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [
        {
          name: 'Only',
          agents: [{ agentId: '', name: 'Worker', templateKey: 'reviewer.custom-2' }],
        },
      ],
    });

    expect(repo.getWorkflowsReferencingTemplate('reviewer.custom')).toHaveLength(0);
    expect(repo.getWorkflowsReferencingTemplate('reviewer.custom-2')).toHaveLength(1);
  });

  test('matches keys with quotes, backslashes, and LIKE wildcards as parsed values', () => {
    repo.createWorkflow({
      spaceId,
      name: 'WF Escaped',
      nodes: [
        {
          name: 'Only',
          agents: [{ agentId: '', name: 'Worker', templateKey: 'we"ird\\key' }],
        },
      ],
    });
    repo.createWorkflow({
      spaceId,
      name: 'WF Plain',
      nodes: [
        { name: 'Only', agents: [{ agentId: '', name: 'Worker', templateKey: 'plainXkey' }] },
      ],
    });

    expect(repo.getWorkflowsReferencingTemplate('we"ird\\key')).toHaveLength(1);
    expect(repo.getWorkflowsReferencingTemplate('plainXkey')).toHaveLength(1);
    expect(repo.getWorkflowsReferencingTemplate('plain_key')).toHaveLength(0);
    expect(repo.getWorkflowsReferencingTemplate('we"ird')).toHaveLength(0);
  });

  test('does not treat keys mentioned only in node instructions as references', () => {
    repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [
        {
          name: 'Only',
          agents: [{ agentId: '', name: 'Worker', templateKey: 'qa.custom' }],
          instructions: 'reviewer.custom mentioned in prose',
        },
      ],
    });

    expect(repo.getWorkflowsReferencingTemplate('reviewer.custom')).toHaveLength(0);
  });

  test('stops reporting a workflow once its current nodes drop the reference', () => {
    const workflow = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [
        { name: 'Only', agents: [{ agentId: '', name: 'Worker', templateKey: 'reviewer.custom' }] },
      ],
    });

    expect(repo.getWorkflowsReferencingTemplate('reviewer.custom')).toHaveLength(1);

    repo.updateWorkflow(workflow.id, {
      nodes: [
        { id: workflow.nodes[0]?.id, name: 'Only', agents: [{ agentId: '', name: 'Worker' }] },
      ],
    });

    expect(repo.getWorkflowsReferencingTemplate('reviewer.custom')).toHaveLength(0);
  });

  test('a run pinned to a definition that referenced the template still blocks deletion', () => {
    const workflow = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [
        { name: 'Only', agents: [{ agentId: '', name: 'Worker', templateKey: 'reviewer.custom' }] },
      ],
    });
    const runRepo = new SpaceWorkflowRunRepository(db);
    const run = runRepo.createPinnedRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Pinned run',
      rawWorkflow: workflow,
    });

    repo.updateWorkflow(workflow.id, {
      nodes: [
        { id: workflow.nodes[0]?.id, name: 'Only', agents: [{ agentId: '', name: 'Worker' }] },
      ],
    });

    const pinnedPayload = db
      .prepare(
        `SELECT payload FROM space_workflow_definition_versions
         WHERE workflow_id = ? AND version_hash = ?`
      )
      .get(workflow.id, run.definitionVersion ?? '') as { payload: string } | undefined;
    expect(pinnedPayload?.payload).toContain('"templateKey":"reviewer.custom"');

    const referencing = repo.getWorkflowsReferencingTemplate('reviewer.custom');
    expect(referencing).toHaveLength(1);
    expect(referencing[0]?.name).toBe('WF');
  });

  test('a run whose tasks are all archived no longer blocks deletion', () => {
    const workflow = repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [
        { name: 'Only', agents: [{ agentId: '', name: 'Worker', templateKey: 'reviewer.custom' }] },
      ],
    });
    const runRepo = new SpaceWorkflowRunRepository(db);
    runRepo.createPinnedRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Pinned run',
      rawWorkflow: workflow,
    });

    repo.updateWorkflow(workflow.id, {
      nodes: [
        { id: workflow.nodes[0]?.id, name: 'Only', agents: [{ agentId: '', name: 'Worker' }] },
      ],
    });
    const runId = (
      db.prepare(`SELECT id FROM space_workflow_runs WHERE workflow_id = ?`).get(workflow.id) as {
        id: string;
      }
    ).id;
    db.prepare(
      `INSERT INTO space_tasks (id, space_id, task_number, title, status, workflow_run_id, archived_at, created_at, updated_at)
       VALUES ('task-1', ?, 1, 'Done task', 'archived', ?, ?, ?, ?)`
    ).run(spaceId, runId, Date.now(), Date.now(), Date.now());

    expect(repo.getWorkflowsReferencingTemplate('reviewer.custom')).toHaveLength(0);
  });

  test('matches slot keys with surrounding whitespace after trimming', () => {
    repo.createWorkflow({
      spaceId,
      name: 'WF Padded',
      nodes: [
        {
          name: 'Only',
          agents: [{ agentId: '', name: 'Worker', templateKey: ' reviewer.custom ' }],
        },
      ],
    });

    expect(repo.getWorkflowsReferencingTemplate('reviewer.custom')).toHaveLength(1);
    expect(repo.getWorkflowsReferencingTemplate('reviewer.custom ')).toHaveLength(1);
    expect(repo.getWorkflowsReferencingTemplate('other.custom')).toHaveLength(0);
  });
});
