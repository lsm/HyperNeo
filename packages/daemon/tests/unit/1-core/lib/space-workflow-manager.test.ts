/**
 * SpaceWorkflowManager Unit Tests
 *
 * Verifies start/end node invariants on create and update operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import { createSpaceAgentSchema, insertSpace } from '../../helpers/space-agent-schema';
import { SpaceWorkflowDefinitionVersionRepository } from '../../../../src/storage/repositories/space-workflow-definition-version-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { computeDefinitionVersion } from '../../../../src/lib/space/workflows/definition-version';

describe('SpaceWorkflowManager', () => {
  let db: Database;
  let repo: SpaceWorkflowRepository;
  let manager: SpaceWorkflowManager;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceAgentSchema(db);
    insertSpace(db);
    repo = new SpaceWorkflowRepository(db as any);
    manager = new SpaceWorkflowManager(repo, null);
  });

  afterEach(() => {
    db.close();
  });

  describe('start/end node validation on create', () => {
    it('defaults startNodeId and endNodeId to first/last node when omitted', () => {
      const result = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Test Workflow',
        nodes: [
          { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          { id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        completionAutonomyLevel: 3,
      });

      expect(result.startNodeId).toBe('node-1');
      expect(result.endNodeId).toBe('node-2');
    });

    it('normalizes null start/end inputs to first/last node', () => {
      const result = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Test Workflow',
        nodes: [
          { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          { id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        startNodeId: null as unknown as string,
        endNodeId: null as unknown as string,
        completionAutonomyLevel: 3,
      });

      expect(result.startNodeId).toBe('node-1');
      expect(result.endNodeId).toBe('node-2');
    });

    it('accepts explicit startNodeId/endNodeId that reference existing nodes', () => {
      const result = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Test Workflow',
        nodes: [
          { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          { id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        startNodeId: 'node-2',
        endNodeId: 'node-1',
        completionAutonomyLevel: 3,
      });

      expect(result.startNodeId).toBe('node-2');
      expect(result.endNodeId).toBe('node-1');
    });

    it('rejects empty string startNodeId', () => {
      expect(() =>
        manager.createWorkflow({
          spaceId: 'space-1',
          name: 'Test Workflow',
          nodes: [
            { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          ],
          startNodeId: '  ',
          completionAutonomyLevel: 3,
        })
      ).toThrow('startNodeId must be a non-empty string');
    });

    it('rejects empty string endNodeId', () => {
      expect(() =>
        manager.createWorkflow({
          spaceId: 'space-1',
          name: 'Test Workflow',
          nodes: [
            { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          ],
          endNodeId: '   ',
          completionAutonomyLevel: 3,
        })
      ).toThrow('endNodeId must be a non-empty string');
    });

    it('rejects startNodeId that does not match any node', () => {
      expect(() =>
        manager.createWorkflow({
          spaceId: 'space-1',
          name: 'Test Workflow',
          nodes: [
            { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          ],
          startNodeId: 'nonexistent-node',
          completionAutonomyLevel: 3,
        })
      ).toThrow('startNodeId "nonexistent-node" does not match any node in this workflow');
    });

    it('rejects endNodeId that does not match any node', () => {
      expect(() =>
        manager.createWorkflow({
          spaceId: 'space-1',
          name: 'Test Workflow',
          nodes: [
            { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          ],
          endNodeId: 'nonexistent-node',
          completionAutonomyLevel: 3,
        })
      ).toThrow('endNodeId "nonexistent-node" does not match any node in this workflow');
    });
  });

  describe('static external event interest validation', () => {
    it('rejects invalid static event interest topics on create', () => {
      expect(() =>
        manager.createWorkflow({
          spaceId: 'space-1',
          name: 'Invalid Event Interest Workflow',
          nodes: [
            {
              id: 'node-1',
              name: 'Step One',
              agents: [
                {
                  agentId: 'agent-1',
                  name: 'coder',
                  eventInterests: [{ topic: 'github/**/pull_request/*.opened' }],
                },
              ],
            },
          ],
          completionAutonomyLevel: 3,
        })
      ).toThrow('Multi-segment "**" wildcard is not supported');
    });

    it('rejects more than 10 static event interests on create', () => {
      expect(() =>
        manager.createWorkflow({
          spaceId: 'space-1',
          name: 'Too Many Event Interests Workflow',
          nodes: [
            {
              id: 'node-1',
              name: 'Step One',
              agents: [
                {
                  agentId: 'agent-1',
                  name: 'coder',
                  eventInterests: Array.from({ length: 11 }, (_, index) => ({
                    topic: `github/*/*/pull_request_${index}.opened`,
                  })),
                },
              ],
            },
          ],
          completionAutonomyLevel: 3,
        })
      ).toThrow('cannot contain more than 10 entries');
    });

    it('rejects invalid static event interest topics on update', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Test Workflow',
        nodes: [
          { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        completionAutonomyLevel: 3,
      });

      expect(() =>
        manager.updateWorkflow(created.id, {
          nodes: [
            {
              id: 'node-1',
              name: 'Step One',
              agents: [
                {
                  agentId: 'agent-1',
                  name: 'coder',
                  eventInterests: [{ topic: 'github/**/pull_request/*.opened' }],
                },
              ],
            },
          ],
        })
      ).toThrow('Multi-segment "**" wildcard is not supported');
    });
  });

  describe('start/end node validation on update', () => {
    it('keeps startNodeId/endNodeId unchanged when omitted', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Test Workflow',
        nodes: [
          { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          { id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        startNodeId: 'node-1',
        endNodeId: 'node-2',
        completionAutonomyLevel: 3,
      });

      const updated = manager.updateWorkflow(created.id, {});
      expect(updated?.startNodeId).toBe('node-1');
      expect(updated?.endNodeId).toBe('node-2');
    });

    it('resets startNodeId/endNodeId to first/last node when null is provided', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Test Workflow',
        nodes: [
          { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          { id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        startNodeId: 'node-2',
        endNodeId: 'node-1',
        completionAutonomyLevel: 3,
      });

      const updated = manager.updateWorkflow(created.id, { startNodeId: null, endNodeId: null });
      expect(updated?.startNodeId).toBe('node-1');
      expect(updated?.endNodeId).toBe('node-2');
    });

    it('accepts valid startNodeId/endNodeId on update (no nodes change)', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Test Workflow',
        nodes: [
          { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          { id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        completionAutonomyLevel: 3,
      });

      const updated = manager.updateWorkflow(created.id, {
        startNodeId: 'node-2',
        endNodeId: 'node-1',
      });
      expect(updated?.startNodeId).toBe('node-2');
      expect(updated?.endNodeId).toBe('node-1');
    });

    it('rejects startNodeId that does not match any existing node', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Test Workflow',
        nodes: [
          { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        completionAutonomyLevel: 3,
      });

      expect(() => manager.updateWorkflow(created.id, { startNodeId: 'nonexistent' })).toThrow(
        'startNodeId "nonexistent" does not match any node in this workflow'
      );
    });

    it('rejects endNodeId that does not match any existing node', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Test Workflow',
        nodes: [
          { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        completionAutonomyLevel: 3,
      });

      expect(() => manager.updateWorkflow(created.id, { endNodeId: 'nonexistent' })).toThrow(
        'endNodeId "nonexistent" does not match any node in this workflow'
      );
    });

    it('validates start/end against effective nodes when stable nodes are updated', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Test Workflow',
        nodes: [
          { id: 'node-1', name: 'Old Step 1', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          { id: 'node-2', name: 'Old Step 2', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        completionAutonomyLevel: 3,
      });

      const updated = manager.updateWorkflow(created.id, {
        nodes: [
          { id: 'node-1', name: 'New Step 1', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          { id: 'node-2', name: 'New Step 2', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        startNodeId: 'node-2',
        endNodeId: 'node-1',
      });

      expect(updated?.startNodeId).toBe('node-2');
      expect(updated?.endNodeId).toBe('node-1');
    });

    it('updates stable nodes in place without changing row IDs', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Stable Update Workflow',
        nodes: [
          { id: 'node-1', name: 'Old Step 1', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          { id: 'node-2', name: 'Old Step 2', agents: [{ agentId: 'agent-2', name: 'reviewer' }] },
        ],
        completionAutonomyLevel: 3,
      });
      const createdNodeRows = db
        .prepare(
          `SELECT id, rowid FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`
        )
        .all(created.id) as Array<{ id: string; rowid: number }>;

      const updated = manager.updateWorkflow(created.id, {
        nodes: [
          { id: 'node-1', name: 'New Step 1', agents: [{ agentId: 'agent-3', name: 'coder' }] },
          { id: 'node-2', name: 'New Step 2', agents: [{ agentId: 'agent-4', name: 'reviewer' }] },
        ],
      });
      const updatedNodeRows = db
        .prepare(
          `SELECT id, rowid FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`
        )
        .all(created.id) as Array<{ id: string; rowid: number }>;

      expect(updated?.nodes.map((node) => node.id)).toEqual(['node-1', 'node-2']);
      expect(updated?.nodes.map((node) => node.name)).toEqual(['New Step 1', 'New Step 2']);
      expect(updatedNodeRows).toEqual(createdNodeRows);
    });

    it('allows structural node additions and removals when incoming node IDs are unique', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Structural Workflow',
        nodes: [
          { id: 'node-old', name: 'Old Step', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          { id: 'node-other', name: 'Other Step', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        completionAutonomyLevel: 3,
      });

      const updated = manager.updateWorkflow(created.id, {
        nodes: [
          { id: 'node-old', name: 'Old Step', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          { id: 'node-new', name: 'New Step', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        endNodeId: 'node-new',
      });

      expect(updated?.nodes.map((node) => node.id)).toEqual(['node-old', 'node-new']);
      expect(updated?.endNodeId).toBe('node-new');
    });

    it('rejects attempts to duplicate, regenerate, or omit node IDs on update', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Test Workflow',
        nodes: [
          { id: 'node-old', name: 'Old Step', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          { id: 'node-other', name: 'Other Step', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        completionAutonomyLevel: 3,
      });

      expect(() =>
        manager.updateWorkflow(created.id, {
          nodes: [
            {
              id: 'node-old',
              name: 'Duplicate 1',
              agents: [{ agentId: 'agent-1', name: 'coder' }],
            },
            {
              id: 'node-old',
              name: 'Duplicate 2',
              agents: [{ agentId: 'agent-1', name: 'coder' }],
            },
          ],
        })
      ).toThrow(
        'Workflow node IDs are stable and cannot be duplicated, regenerated, or omitted during update'
      );

      expect(() =>
        manager.updateWorkflow(created.id, {
          nodes: [{ name: 'Missing ID', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        })
      ).toThrow(
        'Workflow node IDs are stable and cannot be duplicated, regenerated, or omitted during update'
      );
    });

    it('rejects empty string startNodeId/endNodeId on update', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Test Workflow',
        nodes: [
          { id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          { id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        completionAutonomyLevel: 3,
      });

      expect(() => manager.updateWorkflow(created.id, { startNodeId: '  ' })).toThrow(
        'startNodeId must be a non-empty string'
      );
      expect(() => manager.updateWorkflow(created.id, { endNodeId: '  ' })).toThrow(
        'endNodeId must be a non-empty string'
      );
    });
  });

  describe('postApproval validation', () => {
    it('accepts a postApproval route targeting "task-agent" on create', () => {
      const wf = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'WF',
        nodes: [{ id: 'node-1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
        postApproval: { targetAgent: 'task-agent', instructions: 'merge {{pr_url}}' },
      });
      expect(wf.postApproval).toEqual({
        targetAgent: 'task-agent',
        instructions: 'merge {{pr_url}}',
      });
    });

    it('accepts a postApproval route targeting a node agent name', () => {
      const wf = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'WF',
        nodes: [{ id: 'node-1', name: 'Coding', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
        postApproval: { targetAgent: 'coder', instructions: '' },
      });
      expect(wf.postApproval?.targetAgent).toBe('coder');
    });

    it('accepts a node-level postApproval route targeting a node agent name', () => {
      const wf = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'WF',
        nodes: [
          {
            id: 'node-1',
            name: 'Coding',
            agents: [{ agentId: 'agent-1', name: 'coder' }],
            postApproval: { targetAgent: 'coder', instructions: 'ship it' },
          },
        ],
        completionAutonomyLevel: 3,
      });
      expect(wf.nodes[0].postApproval).toEqual({
        targetAgent: 'coder',
        instructions: 'ship it',
      });
    });

    it('rejects a postApproval route whose target does not resolve', () => {
      expect(() =>
        manager.createWorkflow({
          spaceId: 'space-1',
          name: 'WF',
          nodes: [
            { id: 'node-1', name: 'Coding', agents: [{ agentId: 'agent-1', name: 'coder' }] },
          ],
          completionAutonomyLevel: 3,
          postApproval: { targetAgent: 'ghost', instructions: '' },
        })
      ).toThrow('"ghost"');
    });

    it('re-validates an existing postApproval route when stable nodes are updated', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'WF',
        nodes: [
          {
            id: 'node-1',
            name: 'Coding',
            agents: [{ agentId: 'agent-1', name: 'reviewer' }],
          },
        ],
        completionAutonomyLevel: 3,
        postApproval: { targetAgent: 'reviewer', instructions: '' },
      });

      // Update the stable node so `reviewer` is no longer a declared agent.
      expect(() =>
        manager.updateWorkflow(created.id, {
          nodes: [
            {
              id: 'node-1',
              name: 'Coding',
              agents: [{ agentId: 'agent-2', name: 'coder' }],
            },
          ],
        })
      ).toThrow('"reviewer"');
    });

    it('re-validates an existing node-level postApproval route when stable nodes are updated', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'WF',
        nodes: [
          {
            id: 'node-1',
            name: 'Coding',
            agents: [{ agentId: 'agent-1', name: 'reviewer' }],
            postApproval: { targetAgent: 'reviewer', instructions: '' },
          },
        ],
        completionAutonomyLevel: 3,
      });

      expect(() =>
        manager.updateWorkflow(created.id, {
          nodes: [
            {
              id: 'node-1',
              name: 'Coding',
              agents: [{ agentId: 'agent-2', name: 'coder' }],
              postApproval: { targetAgent: 'reviewer', instructions: '' },
            },
          ],
        })
      ).toThrow('node "Coding"');
    });

    it('allows clearing the postApproval route with null', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'WF',
        nodes: [{ id: 'node-1', name: 'Coding', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
        postApproval: { targetAgent: 'coder', instructions: 'hi' },
      });
      expect(created.postApproval).toBeDefined();

      const cleared = manager.updateWorkflow(created.id, { postApproval: null });
      expect(cleared?.postApproval).toBeUndefined();
    });

    it('strips a stale postApproval route on read instead of failing', () => {
      // Persist a route that is valid at create time, then corrupt the DB
      // to simulate a post-hoc node rename that was never re-validated.
      const wf = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'WF',
        nodes: [
          {
            id: 'node-1',
            name: 'Coding',
            agents: [{ agentId: 'agent-1', name: 'reviewer' }],
          },
        ],
        completionAutonomyLevel: 3,
        postApproval: { targetAgent: 'reviewer', instructions: '' },
      });

      // Rename the node agent directly in the config JSON to make the
      // saved route stale. Manager.getWorkflow should sanitise on read.
      const staleCfg = JSON.stringify({
        agents: [{ agentId: 'agent-1', name: 'coder' }],
      });
      db.prepare(`UPDATE space_workflow_nodes SET config = ? WHERE workflow_id = ?`).run(
        staleCfg,
        wf.id
      );

      const fetched = manager.getWorkflow(wf.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.postApproval).toBeUndefined();
    });

    it('strips a stale node-level postApproval route on read instead of failing', () => {
      const wf = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'WF',
        nodes: [
          {
            id: 'node-1',
            name: 'Coding',
            agents: [{ agentId: 'agent-1', name: 'reviewer' }],
            postApproval: { targetAgent: 'reviewer', instructions: '' },
          },
        ],
        completionAutonomyLevel: 3,
      });

      const staleCfg = JSON.stringify({
        agents: [{ agentId: 'agent-1', name: 'coder' }],
        postApproval: { targetAgent: 'reviewer', instructions: '' },
      });
      db.prepare(`UPDATE space_workflow_nodes SET config = ? WHERE workflow_id = ?`).run(
        staleCfg,
        wf.id
      );

      const fetched = manager.getWorkflow(wf.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.nodes[0].postApproval).toBeUndefined();
    });
  });

  describe('handle generation and validation', () => {
    it('auto-generates a handle from the workflow name on create', () => {
      const result = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Coding with QA',
        nodes: [{ id: 'node-1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });
      expect(result.handle).toBe('coding-with-qa');
    });

    it('uses provided handle when explicitly supplied', () => {
      const result = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Coding with QA',
        nodes: [{ id: 'node-1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
        handle: 'custom-handle',
      });
      expect(result.handle).toBe('custom-handle');
    });

    it('appends numeric suffix on handle collision when auto-generating', () => {
      // Seed a handle directly via repo to simulate an existing workflow
      // with a handle that a new workflow's name would collide with.
      repo.createWorkflow({
        spaceId: 'space-1',
        name: 'Existing',
        nodes: [{ name: 'Step', agentId: 'agent-1' }],
        handle: 'collision-test',
      });
      const result = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Collision Test',
        nodes: [{ id: 'node-2', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });
      expect(result.handle).toBe('collision-test-2');
    });

    it('increments suffix for multiple collisions when auto-generating', () => {
      repo.createWorkflow({
        spaceId: 'space-1',
        name: 'Existing A',
        nodes: [{ name: 'Step', agentId: 'agent-1' }],
        handle: 'collision-test',
      });
      repo.createWorkflow({
        spaceId: 'space-1',
        name: 'Existing B',
        nodes: [{ name: 'Step', agentId: 'agent-1' }],
        handle: 'collision-test-2',
      });
      const result = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Collision Test',
        nodes: [{ id: 'n3', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });
      expect(result.handle).toBe('collision-test-3');
    });

    it('regenerates handle on rename when caller does not supply one', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Old Name',
        nodes: [{ id: 'node-1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });
      expect(created.handle).toBe('old-name');

      const updated = manager.updateWorkflow(created.id, { name: 'New Name' });
      expect(updated?.handle).toBe('new-name');
    });

    it('keeps existing handle on rename when caller explicitly provides it', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Old Name',
        nodes: [{ id: 'node-1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });

      const updated = manager.updateWorkflow(created.id, { name: 'New Name', handle: 'old-name' });
      expect(updated?.handle).toBe('old-name');
    });

    it('does not regenerate handle when name is unchanged on update', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Stable Name',
        nodes: [{ id: 'node-1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
        handle: 'custom-handle',
      });
      expect(created.handle).toBe('custom-handle');

      const updated = manager.updateWorkflow(created.id, { name: 'Stable Name' });
      expect(updated?.handle).toBe('custom-handle');
    });

    it('does not regenerate handle on rename when existing handle was cleared', () => {
      // Create, then clear the handle (handle: null). A subsequent rename
      // must NOT auto-generate a new handle — the null state must persist.
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Original Name',
        nodes: [{ id: 'node-1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });
      expect(created.handle).toBeDefined();

      // Clear the handle explicitly.
      const cleared = manager.updateWorkflow(created.id, { handle: null });
      expect(cleared?.handle).toBeUndefined();

      // Rename without providing handle — must stay null, not regenerate.
      const renamed = manager.updateWorkflow(created.id, { name: 'New Name After Clear' });
      expect(renamed?.handle).toBeUndefined();
    });

    it('rejects invalid slug format on create', () => {
      expect(() =>
        manager.createWorkflow({
          spaceId: 'space-1',
          name: 'WF',
          nodes: [{ id: 'node-1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
          completionAutonomyLevel: 3,
          handle: 'My Workflow',
        })
      ).toThrow(/Invalid workflow handle/);
    });

    it('rejects invalid slug format on update', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'WF',
        nodes: [{ id: 'node-1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });

      expect(() => manager.updateWorkflow(created.id, { handle: 'foo@bar' })).toThrow(
        /Invalid workflow handle/
      );
    });

    it('rejects empty handle on update', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'WF',
        nodes: [{ id: 'node-1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });

      expect(() => manager.updateWorkflow(created.id, { handle: '' })).toThrow(
        'Workflow handle must not be empty'
      );
    });

    it('rejects duplicate handle on update', () => {
      manager.createWorkflow({
        spaceId: 'space-1',
        name: 'First',
        nodes: [{ id: 'n1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
        handle: 'first-handle',
      });
      const second = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Second',
        nodes: [{ id: 'n2', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
        handle: 'second-handle',
      });

      expect(() => manager.updateWorkflow(second.id, { handle: 'first-handle' })).toThrow(
        'A workflow with handle "first-handle" already exists in this space'
      );
    });

    it('getWorkflowByHandle returns the workflow when handle exists', () => {
      const created = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Findable',
        nodes: [{ id: 'node-1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
        handle: 'find-me',
      });

      const found = manager.getWorkflowByHandle('space-1', 'find-me');
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    it('getWorkflowByHandle returns null when handle does not exist', () => {
      const found = manager.getWorkflowByHandle('space-1', 'missing');
      expect(found).toBeNull();
    });

    it('allows same handle in different spaces', () => {
      // Insert a second space
      const now = Date.now();
      db.prepare(
        `INSERT INTO spaces (id, workspace_path, name, slug, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
      ).run('space-2', '/ws/2', 'Space 2', 'space-2', now, now);

      const wf1 = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Shared',
        nodes: [{ id: 'n1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
        handle: 'shared',
      });
      const wf2 = manager.createWorkflow({
        spaceId: 'space-2',
        name: 'Shared',
        nodes: [{ id: 'n2', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
        handle: 'shared',
      });

      expect(wf1.handle).toBe('shared');
      expect(wf2.handle).toBe('shared');
    });
  });

  describe('gate validation on create/update', () => {
    it('createWorkflow rejects a gate with an unregistered feature', () => {
      expect(() =>
        manager.createWorkflow({
          spaceId: 'space-1',
          name: 'Bad Gate',
          nodes: [{ id: 'n1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
          gates: [{ id: 'g1', features: { codex_review_bto: true }, resetOnCycle: false }],
          completionAutonomyLevel: 3,
        })
      ).toThrow('gates[0]');
    });

    it('createWorkflow rejects a gate with feature + custom script', () => {
      expect(() =>
        manager.createWorkflow({
          spaceId: 'space-1',
          name: 'Conflicting Gate',
          nodes: [{ id: 'n1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
          gates: [
            {
              id: 'g1',
              features: { codex_review_bot: true },
              script: { interpreter: 'bash', source: 'echo hi' },
              resetOnCycle: false,
            },
          ],
          completionAutonomyLevel: 3,
        })
      ).toThrow('cannot combine');
    });

    it('updateWorkflow rejects gates with invalid features', () => {
      const wf = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Updatable',
        nodes: [{ id: 'n1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });

      expect(() =>
        manager.updateWorkflow(wf.id, {
          gates: [{ id: 'g1', features: { unknown_feature: true }, resetOnCycle: false }],
        })
      ).toThrow('gates[0]');
    });

    it('updateWorkflow accepts valid feature-only gates', () => {
      const wf = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Updatable',
        nodes: [{ id: 'n1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });

      const updated = manager.updateWorkflow(wf.id, {
        gates: [{ id: 'g1', features: { codex_review_bot: true }, resetOnCycle: false }],
      });
      expect(updated).not.toBeNull();
      expect(updated!.gates![0].features).toEqual({ codex_review_bot: true });
    });
  });

  describe('getWorkflowForRun (Phase 1 read cutover)', () => {
    const VERSIONS_DDL = `
      CREATE TABLE space_workflow_definition_versions (
        workflow_id TEXT NOT NULL,
        version_hash TEXT NOT NULL,
        space_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, version_hash),
        FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
      )`;
    let versionRepo: SpaceWorkflowDefinitionVersionRepository;
    let runRepo: SpaceWorkflowRunRepository;
    const RUNS_DDL = `
      CREATE TABLE space_workflow_runs (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        definition_version TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      )`;

    beforeEach(() => {
      db.exec(VERSIONS_DDL);
      db.exec(RUNS_DDL);
      versionRepo = new SpaceWorkflowDefinitionVersionRepository(db as any);
      runRepo = new SpaceWorkflowRunRepository(db as any);
    });

    /** Append a version row for the current head and return its hash. */
    function pinHead(workflowId: string): string {
      const raw = repo.getWorkflow(workflowId)!;
      const { versionHash, payload } = computeDefinitionVersion(raw);
      versionRepo.appendVersion({
        workflowId,
        spaceId: 'space-1',
        versionHash,
        payload,
        source: 'run_create',
        // Content timestamp, mirroring recordDefinitionVersion — preserves the gate-open
        // cache fingerprint across the read cutover.
        createdAt: raw.updatedAt,
      });
      return versionHash;
    }

    it('falls back to the live head when the run has no pin', () => {
      const wf = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'W',
        nodes: [{ id: 'n1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });
      const resolved = manager.getWorkflowForRun({ workflowId: wf.id, definitionVersion: null });
      expect(resolved).toEqual(manager.getWorkflow(wf.id));
    });

    it('resolves a pinned run through its immutable version, ignoring later head edits', () => {
      const wf = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Original',
        nodes: [{ id: 'n1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });
      const pin = pinHead(wf.id);

      // Edit the mutable head AFTER the run was pinned.
      manager.updateWorkflow(wf.id, { name: 'Edited' });

      const resolved = manager.getWorkflowForRun({ workflowId: wf.id, definitionVersion: pin });
      expect(resolved!.name).toBe('Original'); // pinned version wins
      expect(manager.getWorkflow(wf.id)!.name).toBe('Edited'); // head moved on
    });

    it('falls back to the live head when the pinned version row is absent', () => {
      const wf = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'W',
        nodes: [{ id: 'n1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });
      const resolved = manager.getWorkflowForRun({
        workflowId: wf.id,
        definitionVersion: 'version-row-that-does-not-exist',
      });
      expect(resolved).toEqual(manager.getWorkflow(wf.id));
    });

    it('rehydrates a pinned version through sanitize, behaviorally equal to the live path', () => {
      const wf = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'W',
        nodes: [{ id: 'n1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 4,
      });
      const pin = pinHead(wf.id);
      const resolved = manager.getWorkflowForRun({ workflowId: wf.id, definitionVersion: pin })!;
      const live = manager.getWorkflow(wf.id)!;

      // Behavioral fields match. layout/templateHash are absent on the pinned view
      // (non-behavioral, stripped from the version payload) and timestamps are stable
      // (the version row's created_at) rather than the head's volatile values.
      expect(resolved.nodes).toEqual(live.nodes);
      expect(resolved.channels ?? []).toEqual(live.channels ?? []);
      expect(resolved.gates ?? []).toEqual(live.gates ?? []);
      expect(resolved.completionAutonomyLevel).toBe(live.completionAutonomyLevel);
      expect(resolved.startNodeId).toBe(live.startNodeId);
      // updatedAt is the content timestamp, so the gate-open cache fingerprint matches the
      // live path — no spurious gate re-evaluation when pin equals head.
      expect(resolved.updatedAt).toBe(live.updatedAt);
    });

    it('falls back to the live head when the pinned payload cannot be parsed', () => {
      const wf = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'W',
        nodes: [{ id: 'n1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });
      // A damaged version row: hash present, payload corrupt.
      versionRepo.appendVersion({
        workflowId: wf.id,
        spaceId: 'space-1',
        versionHash: 'corrupt-payload',
        payload: '{not valid json',
        source: 'run_create',
        createdAt: Date.now(),
      });
      const resolved = manager.getWorkflowForRun({
        workflowId: wf.id,
        definitionVersion: 'corrupt-payload',
      });
      // Parse failure must not break the run — it resolves to the live head.
      expect(resolved).toEqual(manager.getWorkflow(wf.id));
    });

    it('backfill pins a legacy run to its head, and the pin resolves behaviorally equal to the head', () => {
      const wf = manager.createWorkflow({
        spaceId: 'space-1',
        name: 'Backfill Target',
        nodes: [{ id: 'n1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
        completionAutonomyLevel: 3,
      });
      // Legacy run with no creation-time pin.
      const run = runRepo.createRun({ spaceId: 'space-1', workflowId: wf.id, title: 'Legacy' });
      expect(run.definitionVersion).toBeNull();

      // Startup backfill: pin to the current head (the raw repo read, as wired in rpc-handlers).
      const count = runRepo.backfillDefinitionPins((id) => repo.getWorkflow(id));
      expect(count).toBe(1);

      const pinned = runRepo.getRun(run.id)!;
      expect(pinned.definitionVersion).not.toBeNull();
      // The pin equals the head's version (content-neutral cutover).
      expect(pinned.definitionVersion).toBe(
        computeDefinitionVersion(repo.getWorkflow(wf.id)!).versionHash
      );

      // Resolving through the pin is behaviorally equal to reading the live head.
      const resolved = manager.getWorkflowForRun(pinned)!;
      const head = manager.getWorkflow(wf.id)!;
      expect(resolved.nodes).toEqual(head.nodes);
      expect(resolved.name).toBe(head.name);
      expect(resolved.completionAutonomyLevel).toBe(head.completionAutonomyLevel);
      // updatedAt matches the head, so a backfilled in-progress run's existing gate-open
      // cache fingerprint survives the cutover (no spurious gate re-evaluation).
      expect(resolved.updatedAt).toBe(head.updatedAt);
    });
  });
});
