import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import {
  SpaceWorkflowManager,
  WorkflowValidationError,
  WorkflowDeletionBlockedError,
} from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceAgentLookup } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { WorkflowNodeInput } from '@hyperneo/shared';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpace(db: BunDatabase, spaceId = 'space-1'): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `/tmp/ws-${spaceId}`, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgent(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, name, Date.now(), Date.now());
}

const coderNode: WorkflowNodeInput = { id: 'node-coder', name: 'Code', agentId: 'agent-coder' };
const plannerNode: WorkflowNodeInput = {
  id: 'node-planner',
  name: 'Plan',
  agentId: 'agent-planner',
};
const generalNode: WorkflowNodeInput = {
  id: 'node-general',
  name: 'Review',
  agentId: 'agent-general',
};

describe('SpaceWorkflowRepository', () => {
  let db: BunDatabase;
  let repo: SpaceWorkflowRepository;

  beforeEach(() => {
    db = makeDb();
    seedSpace(db);
    repo = new SpaceWorkflowRepository(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  test('createWorkflow returns workflow with generated id and steps', () => {
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'My Workflow',
      nodes: [coderNode, plannerNode],
      completionAutonomyLevel: 3,
    });

    expect(wf.id).toBeTruthy();
    expect(wf.spaceId).toBe('space-1');
    expect(wf.name).toBe('My Workflow');
    expect(wf.nodes).toHaveLength(2);
    expect(wf.nodes[0].name).toBe('Code');
    expect(wf.nodes[0].agents[0].agentId).toBe('agent-coder');
    expect(wf.nodes[1].name).toBe('Plan');
    expect(wf.tags).toEqual([]);
  });

  test('createWorkflow stores tags', () => {
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'Tagged',
      nodes: [coderNode],
      tags: ['ci', 'deploy'],
      completionAutonomyLevel: 3,
    });
    expect(wf.tags).toEqual(['ci', 'deploy']);
  });

  test('createWorkflow uses first node as startNodeId by default', () => {
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'Auto Start',
      nodes: [coderNode, plannerNode],
      completionAutonomyLevel: 3,
    });
    expect(wf.startNodeId).toBe(coderNode.id);
  });

  test('createWorkflow respects explicit startNodeId', () => {
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'Explicit Start',
      nodes: [coderNode, plannerNode],
      startNodeId: plannerNode.id,
      completionAutonomyLevel: 3,
    });
    expect(wf.startNodeId).toBe(plannerNode.id);
  });

  test('getWorkflow returns null for missing id', () => {
    expect(repo.getWorkflow('no-such-id')).toBeNull();
  });

  test('getWorkflow round-trips all fields', () => {
    const created = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'Full',
      description: 'A full workflow',
      nodes: [coderNode, plannerNode],
      startNodeId: coderNode.id,
      tags: ['a', 'b'],
      completionAutonomyLevel: 3,
    });

    const fetched = repo.getWorkflow(created.id)!;
    expect(fetched.name).toBe('Full');
    expect(fetched.description).toBe('A full workflow');
    expect(fetched.tags).toEqual(['a', 'b']);
    expect(fetched.startNodeId).toBe(coderNode.id);
  });

  test('listWorkflows returns all workflows for a space', () => {
    repo.createWorkflow({
      spaceId: 'space-1',
      name: 'WF1',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    repo.createWorkflow({
      spaceId: 'space-1',
      name: 'WF2',
      nodes: [plannerNode],
      completionAutonomyLevel: 3,
    });
    seedSpace(db, 'space-2');
    repo.createWorkflow({
      spaceId: 'space-2',
      name: 'WF3',
      nodes: [{ name: 'Code', agentId: 'agent-coder' }],
      completionAutonomyLevel: 3,
    });

    const wfs = repo.listWorkflows('space-1');
    expect(wfs).toHaveLength(2);
    expect(wfs.map((w) => w.name).sort()).toEqual(['WF1', 'WF2']);
  });

  test('updateWorkflow updates name and description', () => {
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'Old Name',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    const updated = repo.updateWorkflow(wf.id, { name: 'New Name', description: 'Updated desc' });
    expect(updated?.name).toBe('New Name');
    expect(updated?.description).toBe('Updated desc');
  });

  test('updateWorkflow bumps updatedAt on step-only update', async () => {
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    const before = wf.updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    const updated = repo.updateWorkflow(wf.id, {
      nodes: [{ id: 'node-coder', name: 'Plan', agentId: 'agent-planner' }],
    });
    expect(updated?.updatedAt).toBeGreaterThan(before);
  });

  test('updateWorkflow updates stable nodes in place on nodes param', () => {
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode, plannerNode],
      completionAutonomyLevel: 3,
    });
    expect(wf.nodes).toHaveLength(2);
    const originalRows = db
      .prepare(
        `SELECT id, rowid FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`
      )
      .all(wf.id) as Array<{ id: string; rowid: number }>;

    const updated = repo.updateWorkflow(wf.id, {
      nodes: [plannerNode, { id: 'node-coder', name: 'Review', agentId: 'agent-general' }],
    });
    const reorderedRows = db
      .prepare(
        `SELECT id, rowid FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`
      )
      .all(wf.id) as Array<{ id: string; rowid: number }>;
    expect(updated?.nodes).toHaveLength(2);
    expect(updated?.nodes.map((node) => node.id)).toEqual(['node-planner', 'node-coder']);
    expect(updated?.nodes[1].agents[0].agentId).toBe('agent-general');
    expect(reorderedRows.map((row) => row.id)).toEqual(['node-planner', 'node-coder']);
    expect(new Set(reorderedRows.map((row) => row.rowid))).toEqual(
      new Set(originalRows.map((row) => row.rowid))
    );
  });

  test('updateWorkflow returns null for missing id', () => {
    expect(repo.updateWorkflow('missing', { name: 'X' })).toBeNull();
  });

  test('deleteWorkflow removes the workflow and its steps', () => {
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    expect(repo.deleteWorkflow(wf.id)).toBe(true);
    expect(repo.getWorkflow(wf.id)).toBeNull();

    const rows = db.prepare(`SELECT * FROM space_workflow_nodes WHERE workflow_id = ?`).all(wf.id);
    expect(rows).toHaveLength(0);
  });

  test('deleteWorkflow returns false for missing id', () => {
    expect(repo.deleteWorkflow('no-such-id')).toBe(false);
  });

  test('getWorkflowsReferencingAgent returns workflows with matching agent', () => {
    seedAgent(db, 'agent-1', 'space-1', 'Alpha');
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'WF With Agent',
      nodes: [{ id: 'step-1', name: 'Step', agentId: 'agent-1' }],
      completionAutonomyLevel: 3,
    });
    const results = repo.getWorkflowsReferencingAgent('agent-1');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(wf.id);
  });

  test('getWorkflowsReferencingAgent returns empty for unmatched agent', () => {
    repo.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    expect(repo.getWorkflowsReferencingAgent('no-such-agent')).toHaveLength(0);
  });

  test('getWorkflowsReferencingAgent finds agent referenced via agents[] JSON config (multi-agent step)', () => {
    seedAgent(db, 'agent-multi-1', 'space-1', 'Multi1');
    seedAgent(db, 'agent-multi-2', 'space-1', 'Multi2');
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'Multi-Agent WF',
      nodes: [
        {
          id: 'step-multi',
          name: 'Parallel Step',
          agents: [
            { agentId: 'agent-multi-1', name: 'multi-1' },
            { agentId: 'agent-multi-2', name: 'multi-2' },
          ],
        },
      ],
      completionAutonomyLevel: 3,
    });
    const refs1 = repo.getWorkflowsReferencingAgent('agent-multi-1');
    expect(refs1).toHaveLength(1);
    expect(refs1[0].id).toBe(wf.id);

    const refs2 = repo.getWorkflowsReferencingAgent('agent-multi-2');
    expect(refs2).toHaveLength(1);
    expect(refs2[0].id).toBe(wf.id);

    expect(repo.getWorkflowsReferencingAgent('agent-coder')).toHaveLength(0);
  });

  test('round-trip: step with agents[] is persisted and restored correctly', () => {
    seedAgent(db, 'agent-multi-1', 'space-1', 'Multi1');
    seedAgent(db, 'agent-multi-2', 'space-1', 'Multi2');
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'Multi-Agent Round-Trip',
      nodes: [
        {
          id: 'step-1',
          name: 'Parallel Step',
          agents: [
            {
              agentId: 'agent-multi-1',
              name: 'multi-1',
              instructions: { mode: 'override' as const, value: 'do A' },
            },
            { agentId: 'agent-multi-2', name: 'multi-2' },
          ],
        },
      ],
      completionAutonomyLevel: 3,
    });

    const read = repo.getWorkflow(wf.id);
    expect(read).not.toBeNull();
    const node = read!.nodes[0];

    expect(node.agentId).toBeUndefined();

    expect(node.agents).toHaveLength(2);
    expect(node.agents![0].agentId).toBe('agent-multi-1');
    expect(node.agents![0].instructions).toMatchObject({ mode: 'override', value: 'do A' });
    expect(node.agents![1].agentId).toBe('agent-multi-2');
    expect(node.agents![1].instructions).toBeUndefined();

    expect('instructions' in node).toBe(false);
  });

  test('round-trip: step with channels[] is persisted and restored correctly', () => {
    seedAgent(db, 'agent-multi-1', 'space-1', 'Multi1');
    seedAgent(db, 'agent-multi-2', 'space-1', 'Multi2');
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'Channel Round-Trip',
      nodes: [
        {
          id: 'step-1',
          name: 'Channels Step',
          agents: [
            { agentId: 'agent-multi-1', name: 'multi-1' },
            { agentId: 'agent-multi-2', name: 'multi-2' },
          ],
        },
      ],
      channels: [
        { id: 'ch-1', from: 'Channels Step', to: 'multi-2', label: 'feedback' },
        { id: 'ch-2', from: 'multi-2', to: ['Channels Step', 'Channels Step'] },
      ],
      completionAutonomyLevel: 3,
    });

    const read = repo.getWorkflow(wf.id);
    expect(read).not.toBeNull();
    expect(read!.channels).toHaveLength(2);
    expect(read!.channels![0]).toMatchObject({
      from: 'Channels Step',
      to: 'multi-2',
      label: 'feedback',
    });
    expect(read!.channels![1]).toMatchObject({
      from: 'multi-2',
      to: ['Channels Step', 'Channels Step'],
    });
  });

  test('round-trip: legacy single-agent step (agentId shorthand) normalises to agents[]', () => {
    seedAgent(db, 'agent-1', 'space-1', 'Alpha');
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'Legacy Round-Trip',
      nodes: [
        {
          id: 'step-1',
          name: 'Step',
          agentId: 'agent-1',
        } as unknown as import('@hyperneo/shared').WorkflowNodeInput,
      ],
      completionAutonomyLevel: 3,
    });

    const read = repo.getWorkflow(wf.id);
    expect(read).not.toBeNull();
    const node = read!.nodes[0];

    expect(node.agents[0].agentId).toBe('agent-1');
  });

  test('JSON round-trip: tags are persisted and restored', () => {
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode],
      tags: ['ci', 'deploy'],
      completionAutonomyLevel: 3,
    });
    const fetched = repo.getWorkflow(wf.id)!;
    expect(fetched.tags).toEqual(['ci', 'deploy']);
  });

  test('JSON round-trip: legacy agentId shorthand normalises to agents[] on read-back', () => {
    seedAgent(db, 'agent-99', 'space-1', 'MyAgent');
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'Custom WF',
      nodes: [
        {
          id: 'step-99',
          name: 'Step',
          agentId: 'agent-99',
        } as unknown as import('@hyperneo/shared').WorkflowNodeInput,
      ],
      completionAutonomyLevel: 3,
    });
    const fetched = repo.getWorkflow(wf.id)!;
    expect(fetched.nodes[0].agents[0].agentId).toBe('agent-99');
  });

  test('createWorkflow stores layout and round-trips it', () => {
    const layout = {
      [coderNode.id!]: { x: 100, y: 200 },
      [plannerNode.id!]: { x: 300, y: 400 },
    };
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'Layout WF',
      nodes: [coderNode, plannerNode],
      layout,
      completionAutonomyLevel: 3,
    });
    expect(wf.layout).toEqual(layout);

    const fetched = repo.getWorkflow(wf.id)!;
    expect(fetched.layout).toEqual(layout);
  });

  test('createWorkflow without layout returns undefined layout', () => {
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'No Layout WF',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    expect(wf.layout).toBeUndefined();

    const fetched = repo.getWorkflow(wf.id)!;
    expect(fetched.layout).toBeUndefined();
  });

  test('updateWorkflow sets layout on an existing workflow', () => {
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    expect(wf.layout).toBeUndefined();

    const layout = { [coderNode.id!]: { x: 50, y: 75 } };
    const updated = repo.updateWorkflow(wf.id, { layout });
    expect(updated?.layout).toEqual(layout);

    const fetched = repo.getWorkflow(wf.id)!;
    expect(fetched.layout).toEqual(layout);
  });

  test('updateWorkflow clears layout when null is passed', () => {
    const layout = { [coderNode.id!]: { x: 10, y: 20 } };
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode],
      layout,
      completionAutonomyLevel: 3,
    });
    expect(wf.layout).toEqual(layout);

    const updated = repo.updateWorkflow(wf.id, { layout: null });
    expect(updated?.layout).toBeUndefined();
  });

  test('layout column contains raw JSON in the DB', () => {
    const layout = { [coderNode.id!]: { x: 1, y: 2 } };
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'WF Raw',
      nodes: [coderNode],
      layout,
      completionAutonomyLevel: 3,
    });
    const row = db.prepare('SELECT layout FROM space_workflows WHERE id = ?').get(wf.id) as {
      layout: string;
    };
    expect(JSON.parse(row.layout)).toEqual(layout);
  });
});

describe('SpaceWorkflowManager', () => {
  let db: BunDatabase;
  let repo: SpaceWorkflowRepository;
  let manager: SpaceWorkflowManager;

  beforeEach(() => {
    db = makeDb();
    seedSpace(db);
    repo = new SpaceWorkflowRepository(db);
    manager = new SpaceWorkflowManager(repo, null);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  test('createWorkflow throws if name already exists in space', () => {
    manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Dup',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Dup',
        nodes: [plannerNode],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow allows same name in different spaces', () => {
    seedSpace(db, 'space-2');
    manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Same',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    const wf2 = manager.createWorkflow({
      spaceId: 'space-2',
      name: 'Same',
      nodes: [{ name: 'Code', agentId: 'agent-coder' }],
      completionAutonomyLevel: 3,
    });
    expect(wf2.name).toBe('Same');
  });

  test('updateWorkflow throws if new name conflicts with another workflow', () => {
    manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Existing',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'WF2',
      nodes: [plannerNode],
      completionAutonomyLevel: 3,
    });
    expect(() => manager.updateWorkflow(wf.id, { name: 'Existing' })).toThrow(
      WorkflowValidationError
    );
  });

  test('updateWorkflow allows keeping the same name', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    const updated = manager.updateWorkflow(wf.id, { name: 'WF' });
    expect(updated?.name).toBe('WF');
  });

  test('name is trimmed before storage — whitespace variants collide', () => {
    manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Foo',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: '  Foo  ',
        nodes: [plannerNode],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('name is stored trimmed', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: '  Trimmed  ',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    expect(wf.name).toBe('Trimmed');
  });

  test('createWorkflow throws when steps is empty', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Empty',
        nodes: [],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow throws when steps is not provided (defaults to empty)', () => {
    expect(() =>
      manager.createWorkflow({ spaceId: 'space-1', name: 'NoNodes', completionAutonomyLevel: 3 })
    ).toThrow(WorkflowValidationError);
  });

  test('updateWorkflow throws when replacing with empty steps', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    expect(() => manager.updateWorkflow(wf.id, { nodes: [] })).toThrow(WorkflowValidationError);
  });

  test('updateWorkflow throws when steps is null (treated as empty replacement)', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    expect(() => manager.updateWorkflow(wf.id, { nodes: null as unknown as [] })).toThrow(
      WorkflowValidationError
    );
  });

  test('createWorkflow accepts any non-empty agentId (no lookup)', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [{ name: 'Step', agents: [{ agentId: 'some-uuid', name: 'agent' }] }],
      completionAutonomyLevel: 3,
    });
    expect(wf.nodes[0].agents[0].agentId).toBe('some-uuid');
  });

  test('createWorkflow rejects empty agentId', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Bad AgentId',
        nodes: [{ name: 'Step', agentId: '' }],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow rejects whitespace-only agentId', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Whitespace AgentId',
        nodes: [{ name: 'Step', agentId: '   ' }],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow accepts agentId when agent exists in lookup', () => {
    seedAgent(db, 'agent-1', 'space-1', 'MyAgent');
    const lookup: SpaceAgentLookup = {
      getAgentById: (_spaceId, id) =>
        id === 'agent-1' ? { id: 'agent-1', name: 'MyAgent' } : null,
    };
    const mgr = new SpaceWorkflowManager(repo, lookup);
    const wf = mgr.createWorkflow({
      spaceId: 'space-1',
      name: 'Custom WF',
      nodes: [{ name: 'Step', agents: [{ agentId: 'agent-1', name: 'main' }] }],
      completionAutonomyLevel: 3,
    });
    expect(wf.nodes[0].agents[0].agentId).toBe('agent-1');
  });

  test('createWorkflow rejects agentId when agent does not exist in lookup', () => {
    const lookup: SpaceAgentLookup = {
      getAgentById: () => null,
    };
    const mgr = new SpaceWorkflowManager(repo, lookup);
    expect(() =>
      mgr.createWorkflow({
        spaceId: 'space-1',
        name: 'Bad Agent',
        nodes: [{ name: 'Step', agentId: 'non-existent-uuid' }],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow skips lookup when agentLookup is null', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'No-Lookup WF',
      nodes: [{ name: 'Step', agents: [{ agentId: 'anything', name: 'main' }] }],
      completionAutonomyLevel: 3,
    });
    expect(wf.nodes[0].agents[0].agentId).toBe('anything');
  });

  test('updateWorkflow rejects invalid agentId via lookup', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    const lookup: SpaceAgentLookup = { getAgentById: () => null };
    const mgr = new SpaceWorkflowManager(repo, lookup);
    expect(() =>
      mgr.updateWorkflow(wf.id, {
        nodes: [{ id: 'node-coder', name: 'Step', agentId: 'non-existent' }],
      })
    ).toThrow(WorkflowValidationError);
  });

  test('deleteWorkflow removes an existing workflow', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    expect(manager.deleteWorkflow(wf.id)).toBe(true);
    expect(manager.getWorkflow(wf.id)).toBeNull();
  });

  test('deleteWorkflow returns false for non-existent workflow', () => {
    expect(manager.deleteWorkflow('no-such-id')).toBe(false);
  });

  function seedRunWithTask(
    workflowId: string,
    opts: { archived?: boolean; status?: string } = {}
  ): string {
    const now = Date.now();
    const runId = `run-${Math.random().toString(36).slice(2)}`;
    db.prepare(
      `INSERT INTO space_workflow_runs
         (id, space_id, workflow_id, definition_version, title, status, created_at, updated_at)
       VALUES (?, 'space-1', ?, NULL, 'R', ?, ?, ?)`
    ).run(runId, workflowId, opts.status ?? 'in_progress', now, now);
    db.prepare(
      `INSERT INTO space_tasks
         (id, space_id, task_number, title, status, workflow_run_id, archived_at, created_at, updated_at)
       VALUES (?, 'space-1', ?, 'T', 'open', ?, ?, ?, ?)`
    ).run(`task-${runId}`, runId, runId, opts.archived ? now : null, now, now);
    return runId;
  }

  test('deleteWorkflow throws WorkflowDeletionBlockedError when a non-archived run exists', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'WithRun',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    seedRunWithTask(wf.id);
    expect(() => manager.deleteWorkflow(wf.id)).toThrow(WorkflowDeletionBlockedError);
    expect(manager.getWorkflow(wf.id)).not.toBeNull();
  });

  test('deleteWorkflow throws for a non-terminal run with no task yet (startup window)', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Starting',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    const now = Date.now();
    db.prepare(
      `INSERT INTO space_workflow_runs
         (id, space_id, workflow_id, definition_version, title, status, created_at, updated_at)
       VALUES (?, 'space-1', ?, NULL, 'R', 'in_progress', ?, ?)`
    ).run(`run-${wf.id}`, wf.id, now, now);
    expect(() => manager.deleteWorkflow(wf.id)).toThrow(WorkflowDeletionBlockedError);
    expect(manager.getWorkflow(wf.id)).not.toBeNull();
  });

  test('deleteWorkflow succeeds once the executable run is a tombstone', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Archivable',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    seedRunWithTask(wf.id, { archived: true, status: 'cancelled' });
    expect(manager.deleteWorkflow(wf.id)).toBe(true);
    expect(manager.getWorkflow(wf.id)).toBeNull();
  });

  test('steps are stored and retrieved in insertion order', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Ordered',
      nodes: [plannerNode, coderNode, generalNode],
      completionAutonomyLevel: 3,
    });
    expect(wf.nodes[0].name).toBe('Plan');
    expect(wf.nodes[1].name).toBe('Code');
    expect(wf.nodes[2].name).toBe('Review');
  });

  test('getWorkflowsReferencingAgent returns workflows using given agent', () => {
    seedAgent(db, 'agent-1', 'space-1', 'Alpha');
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Uses Alpha',
      nodes: [{ id: 'step-1', name: 'Step', agentId: 'agent-1' }],
      completionAutonomyLevel: 3,
    });
    manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Uses Other',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    const refs = manager.getWorkflowsReferencingAgent('agent-1');
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe(wf.id);
  });

  test('createWorkflow rejects agents[] entry with empty agentId (no lookup)', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Bad Agents Empty',
        nodes: [
          {
            name: 'Step',
            agents: [{ agentId: '' }],
          },
        ],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow rejects agents[] entry with whitespace-only agentId (no lookup)', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Bad Agents Whitespace',
        nodes: [
          {
            name: 'Step',
            agents: [{ agentId: '   ' }],
          },
        ],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow accepts agents[] with non-empty agentIds (no lookup)', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Valid Agents',
      nodes: [
        {
          name: 'Step',
          agents: [
            { agentId: 'agent-a', name: 'a' },
            { agentId: 'agent-b', name: 'b' },
          ],
        },
        { name: 'End', agentId: 'agent-a' },
      ],
      completionAutonomyLevel: 3,
    });
    expect(wf.nodes[0].agents).toHaveLength(2);
  });

  test('updateWorkflow rejects agents[] entry with empty agentId (no lookup)', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    expect(() =>
      manager.updateWorkflow(wf.id, {
        nodes: [{ id: 'node-coder', name: 'Step', agents: [{ agentId: '' }] }],
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow rejects channels with empty from', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Empty From',
        nodes: [{ name: 'Step', agents: [{ agentId: 'agent-a', name: 'a' }] }],
        channels: [{ id: 'ch-1', from: '', to: 'Step' }],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow rejects channels with empty string to', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Empty To',
        nodes: [{ name: 'Step', agents: [{ agentId: 'agent-a', name: 'a' }] }],
        channels: [{ id: 'ch-1', from: 'Step', to: '' }],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow rejects channels with empty array to', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Empty Array To',
        nodes: [{ name: 'Step', agents: [{ agentId: 'agent-a', name: 'a' }] }],
        channels: [{ id: 'ch-1', from: 'Step', to: [] as string[] }],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow rejects channels with whitespace-only from', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Whitespace From',
        nodes: [{ name: 'Step', agents: [{ agentId: 'agent-a', name: 'a' }] }],
        channels: [{ id: 'ch-1', from: '   ', to: 'Step' }],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow rejects channels with whitespace-only string to', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Whitespace To',
        nodes: [{ name: 'Step', agents: [{ agentId: 'agent-a', name: 'a' }] }],
        channels: [{ id: 'ch-1', from: 'Step', to: '   ' }],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow rejects channels with whitespace-only element in array to', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Whitespace Array To Element',
        nodes: [{ name: 'Step', agents: [{ agentId: 'agent-a', name: 'a' }] }],
        channels: [{ id: 'ch-1', from: 'Step', to: ['   '] }],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow accepts valid channels with * wildcard (no lookup)', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Wildcard Channels',
      nodes: [
        { id: 'n1', name: 'Code', agents: [{ agentId: 'agent-a', name: 'a' }] },
        { id: 'n2', name: 'Review', agents: [{ agentId: 'agent-b', name: 'b' }] },
      ],
      channels: [{ id: 'ch-1', from: '*', to: 'Review' }],
      startNodeId: 'n1',
      completionAutonomyLevel: 3,
    });
    expect(wf.channels).toHaveLength(1);
    expect(wf.channels![0].from).toBe('*');
  });

  test('createWorkflow accepts valid one-way channel with array to (no lookup)', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Array To Channels',
      nodes: [
        { id: 'n1', name: 'Code', agents: [{ agentId: 'agent-a', name: 'a' }] },
        { id: 'n2', name: 'Review', agents: [{ agentId: 'agent-b', name: 'b' }] },
        { id: 'n3', name: 'QA', agents: [{ agentId: 'agent-a', name: 'qa' }] },
      ],
      channels: [{ id: 'ch-1', from: 'Code', to: ['Review', 'QA'] }],
      startNodeId: 'n1',
      completionAutonomyLevel: 3,
    });
    expect(wf.channels).toHaveLength(1);
    expect(wf.channels![0].to).toEqual(['Review', 'QA']);
  });

  test('createWorkflow stores channels at workflow level (not node level)', () => {
    seedAgent(db, 'agent-coder-id', 'space-1', 'CoderAgent');
    seedAgent(db, 'agent-reviewer-id', 'space-1', 'ReviewerAgent');
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Channels At Workflow Level',
      nodes: [
        { id: 'n1', name: 'Code', agents: [{ agentId: 'agent-coder-id', name: 'coder' }] },
        { id: 'n2', name: 'Review', agents: [{ agentId: 'agent-reviewer-id', name: 'reviewer' }] },
      ],
      channels: [{ id: 'ch-1', from: 'Code', to: 'Review' }],
      startNodeId: 'n1',
      completionAutonomyLevel: 3,
    });
    expect(wf.channels).toHaveLength(1);
    expect(wf.channels![0].from).toBe('Code');
    expect(wf.channels![0].to).toBe('Review');
  });

  test('createWorkflow accepts channels with any from/to values (no agent lookup validation)', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Any Role Channels',
      nodes: [{ name: 'Step', agents: [{ agentId: 'agent-coder-id', name: 'coder' }] }],
      channels: [{ id: 'ch-1', from: 'arbitrary-source', to: 'arbitrary-target' }],
      completionAutonomyLevel: 3,
    });
    expect(wf.channels).toHaveLength(1);
  });

  test('createWorkflow accepts * wildcard channels (always valid)', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Wildcard Channels 2',
      nodes: [{ name: 'Step', agents: [{ agentId: 'agent-coder-id', name: 'coder' }] }],
      channels: [{ id: 'ch-1', from: '*', to: '*' }],
      completionAutonomyLevel: 3,
    });
    expect(wf.channels).toHaveLength(1);
    expect(wf.channels![0].from).toBe('*');
  });

  test('updateWorkflow stores channels at workflow level when updating a stable step', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'WF',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    const updated = manager.updateWorkflow(wf.id, {
      nodes: [
        { id: 'node-coder', name: 'Code', agents: [{ agentId: 'agent-coder-id', name: 'coder' }] },
      ],
      channels: [{ id: 'ch-1', from: 'Code', to: 'Review' }],
      startNodeId: 'node-coder',
    });
    expect(updated!.channels).toHaveLength(1);
    expect(updated!.channels![0].from).toBe('Code');
  });

  test('createWorkflow with multi-agent step and channels persists and reads back correctly', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Multi-Agent CRUD',
      nodes: [
        {
          id: 'step-1',
          name: 'Code',
          agents: [
            {
              agentId: 'agent-coder',
              name: 'coder',
              instructions: { mode: 'override', value: 'write code' },
            },
            { agentId: 'agent-reviewer', name: 'reviewer' },
          ],
        },
        {
          id: 'step-2',
          name: 'Review',
          agents: [{ agentId: 'agent-reviewer', name: 'reviewer2' }],
        },
      ],
      channels: [{ id: 'ch-1', from: 'Code', to: 'Review', label: 'submit' }],
      startNodeId: 'step-1',
      completionAutonomyLevel: 3,
    });

    const read = manager.getWorkflow(wf.id)!;
    const node = read.nodes[0];
    expect(node.agentId).toBeUndefined();
    expect(node.agents).toHaveLength(2);
    expect(node.agents![0].agentId).toBe('agent-coder');
    expect(node.agents![0].instructions).toMatchObject({ mode: 'override', value: 'write code' });
    expect(node.agents![1].agentId).toBe('agent-reviewer');
    expect('instructions' in node).toBe(false);
    expect(read.channels).toHaveLength(1);
    expect(read.channels![0]).toMatchObject({
      from: 'Code',
      to: 'Review',
      label: 'submit',
    });
  });

  test('updateWorkflow updates a stable node with multi-agent config correctly', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Update Multi-Agent',
      nodes: [
        { id: 'step-parallel', name: 'Code', agents: [{ agentId: 'agent-a', name: 'a' }] },
        { id: 'step-end', name: 'End', agents: [{ agentId: 'agent-a', name: 'end' }] },
      ],
      startNodeId: 'step-parallel',
      endNodeId: 'step-end',
      completionAutonomyLevel: 3,
    });

    const updated = manager.updateWorkflow(wf.id, {
      nodes: [
        {
          id: 'step-parallel',
          name: 'New Parallel Step',
          agents: [
            { agentId: 'agent-a', name: 'a' },
            { agentId: 'agent-b', name: 'b' },
          ],
        },
        { id: 'step-end', name: 'End', agents: [{ agentId: 'agent-a', name: 'end' }] },
      ],
      startNodeId: 'step-parallel',
      endNodeId: 'step-end',
    })!;

    const node = updated.nodes[0];
    expect(node.agentId).toBeUndefined();
    expect(node.agents).toHaveLength(2);
    expect(updated.channels).toBeUndefined();
  });

  test('deleteWorkflow with multi-agent step cleans up correctly', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Delete Multi-Agent',
      nodes: [
        {
          id: 'step-1',
          name: 'Parallel Step',
          agents: [
            { agentId: 'agent-a', name: 'a' },
            { agentId: 'agent-b', name: 'b' },
          ],
        },
        { id: 'step-end', name: 'End', agentId: 'agent-a' },
      ],
      startNodeId: 'step-1',
      endNodeId: 'step-end',
      completionAutonomyLevel: 3,
    });

    expect(manager.deleteWorkflow(wf.id)).toBe(true);
    expect(manager.getWorkflow(wf.id)).toBeNull();
  });

  test('legacy single-agent workflow continues to work alongside multi-agent workflows', () => {
    const single = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Single Agent',
      nodes: [coderNode],
      completionAutonomyLevel: 3,
    });
    const multi = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Multi Agent',
      nodes: [
        {
          id: 'step-m',
          name: 'Parallel',
          agents: [
            { agentId: 'agent-x', name: 'x' },
            { agentId: 'agent-y', name: 'y' },
          ],
        },
        { id: 'step-end', name: 'End', agentId: 'agent-x' },
      ],
      startNodeId: 'step-m',
      endNodeId: 'step-end',
      completionAutonomyLevel: 3,
    });

    const workflows = manager.listWorkflows('space-1');
    expect(workflows).toHaveLength(2);

    const readSingle = manager.getWorkflow(single.id)!;
    expect(readSingle.nodes[0].agents[0].agentId).toBe('agent-coder');
    expect(readSingle.channels).toBeUndefined();

    const readMulti = manager.getWorkflow(multi.id)!;
    expect(readMulti.nodes[0].agents).toHaveLength(2);
    expect(readMulti.channels).toBeUndefined();
  });

  test('createWorkflow rejects agents[] entry with empty role (no lookup)', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Empty Role',
        nodes: [
          {
            name: 'Step',
            agents: [{ agentId: 'agent-a', name: '' }],
          },
        ],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow rejects agents[] with duplicate roles in same node (no lookup)', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Duplicate Roles',
        nodes: [
          {
            name: 'Step',
            agents: [
              { agentId: 'agent-a', name: 'same-role' },
              { agentId: 'agent-b', name: 'same-role' },
            ],
          },
        ],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('createWorkflow accepts same agentId with different roles (no lookup)', () => {
    const wf = manager.createWorkflow({
      spaceId: 'space-1',
      name: 'Same Agent Diff Roles',
      nodes: [
        {
          name: 'Step',
          agents: [
            { agentId: 'agent-a', name: 'strict-reviewer' },
            { agentId: 'agent-a', name: 'quick-reviewer' },
          ],
        },
        { name: 'End', agentId: 'agent-a' },
      ],
      completionAutonomyLevel: 3,
    });
    expect(wf.nodes[0].agents).toHaveLength(2);
    expect(wf.nodes[0].agents![0].name).toBe('strict-reviewer');
    expect(wf.nodes[0].agents![1].name).toBe('quick-reviewer');
  });

  test('repo backfills role = agentId for legacy rows persisted without role', () => {
    const wf = repo.createWorkflow({
      spaceId: 'space-1',
      name: 'Legacy No-Role WF',
      nodes: [
        {
          id: 'step-legacy',
          name: 'Legacy Step',
          // @ts-expect-error intentionally omitting name to simulate pre-name DB rows
          agents: [{ agentId: 'agent-old-1' }, { agentId: 'agent-old-2' }],
        },
      ],
      completionAutonomyLevel: 3,
    });

    const read = repo.getWorkflow(wf.id)!;
    const node = read.nodes[0];
    expect(node.agents).toHaveLength(2);
    expect(node.agents![0].name).toBe('agent-old-1');
    expect(node.agents![1].name).toBe('agent-old-2');
  });
});
