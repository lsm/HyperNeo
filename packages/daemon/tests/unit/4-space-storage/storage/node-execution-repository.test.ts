import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('NodeExecutionRepository', () => {
  let db: Database;
  let spaceRepo: SpaceRepository;
  let runRepo: SpaceWorkflowRunRepository;
  let repo: NodeExecutionRepository;
  let spaceId: string;
  let workflowId: string;
  let workflowRunId: string;
  let agentId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    spaceRepo = new SpaceRepository(db as any);
    runRepo = new SpaceWorkflowRunRepository(db as any);
    repo = new NodeExecutionRepository(db as any);

    const space = spaceRepo.createSpace({
      workspacePath: '/workspace/test',
      slug: 'test',
      name: 'Test Space',
    });
    spaceId = space.id;

    workflowId = 'wf-1';
    agentId = 'agent-1';
    const now = Date.now();

    (db as any)
      .prepare(
        `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(workflowId, spaceId, 'My Workflow', now, now);

    const run = runRepo.createRun({ spaceId, workflowId, title: 'Run #1' });
    workflowRunId = run.id;

    (db as any)
      .prepare(
        `INSERT INTO space_agents (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(agentId, spaceId, 'Coder', now, now);
  });

  afterEach(() => {
    db.close();
  });

  function createExecution(
    overrides: Partial<import('@hyperneo/shared').CreateNodeExecutionParams> = {}
  ) {
    return repo.create({
      workflowRunId,
      workflowNodeId: 'node-1',
      agentName: 'coder',
      agentId,
      ...overrides,
    });
  }

  function createExecutionWithTimestamp(
    overrides: Partial<import('@hyperneo/shared').CreateNodeExecutionParams> & { createdAt: number }
  ) {
    const { createdAt, ...rest } = overrides;
    const id = crypto.randomUUID();
    const now = Date.now();
    (db as any)
      .prepare(
        `INSERT INTO node_executions
				    (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				     agent_session_id, status, result, created_at, started_at,
				     completed_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        workflowRunId,
        'node-1',
        rest.agentName ?? 'coder',
        agentId,
        null,
        'pending',
        null,
        createdAt,
        null,
        null,
        now
      );
    return repo.getById(id)!;
  }

  describe('create', () => {
    it('creates a node execution with required fields', () => {
      const exec = createExecution();

      expect(exec.id).toBeDefined();
      expect(exec.workflowRunId).toBe(workflowRunId);
      expect(exec.workflowNodeId).toBe('node-1');
      expect(exec.agentName).toBe('coder');
      expect(exec.agentId).toBe(agentId);
      expect(exec.status).toBe('pending');
      expect(exec.agentSessionId).toBeNull();
      expect(exec.result).toBeNull();
      expect(exec.createdAt).toBeGreaterThan(0);
      expect(exec.startedAt).toBeNull();
      expect(exec.completedAt).toBeNull();
      expect(exec.updatedAt).toBeGreaterThan(0);
    });

    it('creates with a custom initial status', () => {
      const exec = createExecution({ status: 'in_progress' });
      expect(exec.status).toBe('in_progress');
    });

    it('creates with an agent session ID', () => {
      const exec = createExecution({ agentSessionId: 'session-abc' });
      expect(exec.agentSessionId).toBe('session-abc');
    });

    it('creates with a different agent', () => {
      const exec = createExecution({ agentName: 'reviewer', agentId });
      expect(exec.agentName).toBe('reviewer');
    });

    it('creates with a different workflow run', () => {
      const run2 = runRepo.createRun({ spaceId, workflowId, title: 'Run #2' });
      const exec = createExecution({ workflowRunId: run2.id });
      expect(exec.workflowRunId).toBe(run2.id);
    });

    it('creates with a different node', () => {
      const exec = createExecution({ workflowNodeId: 'node-2' });
      expect(exec.workflowNodeId).toBe('node-2');
    });
  });

  describe('getById', () => {
    it('returns a node execution by ID', () => {
      const created = createExecution();
      const found = repo.getById(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('returns null for unknown ID', () => {
      expect(repo.getById('nonexistent')).toBeNull();
    });

    it('round-trips all fields correctly', () => {
      const exec = createExecution({
        workflowNodeId: 'node-review',
        agentName: 'reviewer',
        agentId,
      });
      const fetched = repo.getById(exec.id)!;
      expect(fetched.workflowRunId).toBe(workflowRunId);
      expect(fetched.workflowNodeId).toBe('node-review');
      expect(fetched.agentName).toBe('reviewer');
      expect(fetched.agentId).toBe(agentId);
    });
  });

  describe('listByWorkflowRun', () => {
    it('lists all node executions for a workflow run', () => {
      createExecution({ workflowNodeId: 'node-1', agentName: 'coder' });
      createExecution({ workflowNodeId: 'node-1', agentName: 'reviewer' });
      createExecution({ workflowNodeId: 'node-2', agentName: 'qa' });

      const executions = repo.listByWorkflowRun(workflowRunId);
      expect(executions).toHaveLength(3);
    });

    it('returns empty for a run with no executions', () => {
      const run2 = runRepo.createRun({ spaceId, workflowId, title: 'Run #2' });
      expect(repo.listByWorkflowRun(run2.id)).toHaveLength(0);
    });

    it('does not include executions from other runs', () => {
      createExecution({ workflowNodeId: 'node-1', agentName: 'coder' });

      const run2 = runRepo.createRun({ spaceId, workflowId, title: 'Run #2' });
      createExecution({
        workflowRunId: run2.id,
        workflowNodeId: 'node-1',
        agentName: 'reviewer',
      });

      const run1Execs = repo.listByWorkflowRun(workflowRunId);
      expect(run1Execs).toHaveLength(1);
      expect(run1Execs[0].agentName).toBe('coder');
    });

    it('orders by created_at ASC', () => {
      const e1 = createExecution({ agentName: 'first' });
      const base = Date.now();
      const e2 = createExecutionWithTimestamp({ agentName: 'second', createdAt: base + 1 });
      const e3 = createExecutionWithTimestamp({ agentName: 'third', createdAt: base + 2 });

      const executions = repo.listByWorkflowRun(workflowRunId);
      expect(executions.map((e) => e.agentName)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('listByNode', () => {
    it('lists node executions for a specific node within a run', () => {
      createExecution({ workflowNodeId: 'node-A', agentName: 'coder' });
      createExecution({ workflowNodeId: 'node-A', agentName: 'reviewer' });
      createExecution({ workflowNodeId: 'node-B', agentName: 'qa' });

      const nodeAExecs = repo.listByNode(workflowRunId, 'node-A');
      expect(nodeAExecs).toHaveLength(2);
      expect(nodeAExecs.every((e) => e.workflowNodeId === 'node-A')).toBe(true);
    });

    it('returns empty for a node with no executions', () => {
      const execs = repo.listByNode(workflowRunId, 'nonexistent-node');
      expect(execs).toHaveLength(0);
    });

    it('does not include executions from other runs for the same node ID', () => {
      createExecution({ workflowNodeId: 'node-1', agentName: 'coder' });

      const run2 = runRepo.createRun({ spaceId, workflowId, title: 'Run #2' });
      createExecution({
        workflowRunId: run2.id,
        workflowNodeId: 'node-1',
        agentName: 'reviewer',
      });

      const node1Execs = repo.listByNode(workflowRunId, 'node-1');
      expect(node1Execs).toHaveLength(1);
      expect(node1Execs[0].agentName).toBe('coder');
    });
  });

  describe('update', () => {
    it('updates status and stamps startedAt for in_progress', () => {
      const exec = createExecution();
      const updated = repo.update(exec.id, { status: 'in_progress' });

      expect(updated!.status).toBe('in_progress');
      expect(updated!.startedAt).not.toBeNull();
      expect(updated!.startedAt).toBeGreaterThan(0);
    });

    it('updates status and stamps completedAt for idle', () => {
      const exec = createExecution();
      repo.update(exec.id, { status: 'in_progress' });
      const updated = repo.update(exec.id, { status: 'idle' });

      expect(updated!.status).toBe('idle');
      expect(updated!.completedAt).not.toBeNull();
      expect(updated!.completedAt).toBeGreaterThan(0);
    });

    it('updates status and stamps completedAt for blocked', () => {
      const exec = createExecution();
      const updated = repo.update(exec.id, { status: 'blocked' });

      expect(updated!.status).toBe('blocked');
      expect(updated!.completedAt).not.toBeNull();
    });

    it('updates status and stamps completedAt for cancelled', () => {
      const exec = createExecution();
      const updated = repo.update(exec.id, { status: 'cancelled' });

      expect(updated!.status).toBe('cancelled');
      expect(updated!.completedAt).not.toBeNull();
    });

    it('explicit startedAt overrides auto-stamp when status is in_progress', () => {
      const exec = createExecution();
      const explicitTime = 1000000;
      const updated = repo.update(exec.id, {
        status: 'in_progress',
        startedAt: explicitTime,
      });

      expect(updated!.status).toBe('in_progress');
      expect(updated!.startedAt).toBe(explicitTime);
    });

    it('explicit completedAt overrides auto-stamp when status is idle', () => {
      const exec = createExecution();
      const explicitTime = 2000000;
      const updated = repo.update(exec.id, {
        status: 'idle',
        completedAt: explicitTime,
      });

      expect(updated!.status).toBe('idle');
      expect(updated!.completedAt).toBe(explicitTime);
    });

    it('updates agentSessionId', () => {
      const exec = createExecution();
      const updated = repo.update(exec.id, { agentSessionId: 'session-xyz' });
      expect(updated!.agentSessionId).toBe('session-xyz');
    });

    it('clears agentSessionId with null', () => {
      const exec = createExecution({ agentSessionId: 'session-abc' });
      const updated = repo.update(exec.id, { agentSessionId: null });
      expect(updated!.agentSessionId).toBeNull();
    });

    it('updates result', () => {
      const exec = createExecution();
      const updated = repo.update(exec.id, { result: 'All tests passed' });
      expect(updated!.result).toBe('All tests passed');
    });

    it('clears result with null', () => {
      const exec = createExecution();
      repo.update(exec.id, { result: 'Some result' });
      const updated = repo.update(exec.id, { result: null });
      expect(updated!.result).toBeNull();
    });

    it('updates multiple fields at once', () => {
      const exec = createExecution();
      const updated = repo.update(exec.id, {
        status: 'idle',
        agentSessionId: 'session-final',
        result: 'Completed successfully',
      });

      expect(updated!.status).toBe('idle');
      expect(updated!.agentSessionId).toBe('session-final');
      expect(updated!.result).toBe('Completed successfully');
      expect(updated!.completedAt).not.toBeNull();
    });

    it('no-op update returns unchanged execution', () => {
      const exec = createExecution();
      const updated = repo.update(exec.id, {});
      expect(updated!.id).toBe(exec.id);
      expect(updated!.status).toBe(exec.status);
    });

    it('returns null for unknown ID', () => {
      const updated = repo.update('nonexistent', { status: 'done' });
      expect(updated).toBeNull();
    });

    it('updates updatedAt timestamp on every change', () => {
      const exec = createExecution();
      const originalUpdatedAt = exec.updatedAt;

      const updated = repo.update(exec.id, { status: 'in_progress' });
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
    });
  });

  describe('updateStatus', () => {
    it('transitions pending → in_progress', () => {
      const exec = createExecution();
      const updated = repo.updateStatus(exec.id, 'in_progress');
      expect(updated!.status).toBe('in_progress');
      expect(updated!.startedAt).not.toBeNull();
    });

    it('transitions in_progress → idle', () => {
      const exec = createExecution();
      repo.updateStatus(exec.id, 'in_progress');
      const updated = repo.updateStatus(exec.id, 'idle');
      expect(updated!.status).toBe('idle');
      expect(updated!.completedAt).not.toBeNull();
    });

    it('transitions pending → blocked directly', () => {
      const exec = createExecution();
      const updated = repo.updateStatus(exec.id, 'blocked');
      expect(updated!.status).toBe('blocked');
      expect(updated!.completedAt).not.toBeNull();
    });

    it('transitions pending → cancelled directly', () => {
      const exec = createExecution();
      const updated = repo.updateStatus(exec.id, 'cancelled');
      expect(updated!.status).toBe('cancelled');
      expect(updated!.completedAt).not.toBeNull();
    });
  });

  describe('casExecutionStatus', () => {
    it("returns 'won' and flips the status on an exact match", () => {
      const exec = createExecution();
      expect(repo.casExecutionStatus(exec.id, 'pending', 'blocked')).toBe('won');
      expect(repo.getById(exec.id)!.status).toBe('blocked');
    });

    it("returns 'won' when the current status is in the expected set", () => {
      const exec = createExecution();
      repo.updateStatus(exec.id, 'waiting_rebind');
      expect(repo.casExecutionStatus(exec.id, ['pending', 'waiting_rebind'], 'blocked')).toBe(
        'won'
      );
      expect(repo.getById(exec.id)!.status).toBe('blocked');
    });

    it("returns 'superseded' and leaves the row unchanged when the status moved first", () => {
      const exec = createExecution();
      repo.updateStatus(exec.id, 'in_progress');
      expect(repo.casExecutionStatus(exec.id, 'pending', 'blocked')).toBe('superseded');
      expect(repo.getById(exec.id)!.status).toBe('in_progress');
    });

    it("returns 'superseded' for an unknown execution id", () => {
      expect(repo.casExecutionStatus('nonexistent', 'pending', 'blocked')).toBe('superseded');
    });

    it("returns 'superseded' for an empty expected set without writing", () => {
      const exec = createExecution();
      expect(repo.casExecutionStatus(exec.id, [], 'blocked')).toBe('superseded');
      expect(repo.getById(exec.id)!.status).toBe('pending');
    });

    it('touches no other rows', () => {
      const target = createExecution({ agentName: 'target' });
      const other = createExecution({ agentName: 'other' });
      const otherBefore = repo.getById(other.id);
      expect(repo.casExecutionStatus(target.id, 'pending', 'blocked')).toBe('won');
      expect(repo.getById(other.id)).toEqual(otherBefore);
    });

    it('stamps no timestamps and emits no reactive notification', () => {
      const calls: Array<{ table: string; scope?: unknown }> = [];
      const reactiveDb = {
        notifyChange: (table: string, scope?: unknown) => calls.push({ table, scope }),
      };
      const reactiveRepo = new NodeExecutionRepository(
        db as unknown as Parameters<typeof NodeExecutionRepository.prototype.constructor>[0],
        reactiveDb as unknown as Parameters<typeof NodeExecutionRepository.prototype.constructor>[1]
      );
      const exec = createExecution();

      expect(reactiveRepo.casExecutionStatus(exec.id, 'pending', 'blocked')).toBe('won');

      const after = repo.getById(exec.id)!;
      expect(after.startedAt).toBeNull();
      expect(after.completedAt).toBeNull();
      expect(calls).toEqual([]);
    });
  });

  describe('updateSessionId', () => {
    it('sets the session ID', () => {
      const exec = createExecution();
      const updated = repo.updateSessionId(exec.id, 'session-abc');
      expect(updated!.agentSessionId).toBe('session-abc');
    });

    it('clears the session ID', () => {
      const exec = createExecution({ agentSessionId: 'session-abc' });
      const updated = repo.updateSessionId(exec.id, null);
      expect(updated!.agentSessionId).toBeNull();
    });
  });

  describe('getByAgentSessionId', () => {
    it('prefers active executions when a reused session appears on multiple rows', () => {
      const sessionId = 'session-reused';
      const idleExec = createExecution({
        workflowNodeId: 'node-old',
        agentSessionId: sessionId,
        status: 'idle',
      });
      const activeExec = createExecution({
        workflowNodeId: 'node-current',
        agentSessionId: sessionId,
        status: 'in_progress',
      });

      expect(repo.getByAgentSessionId(sessionId)?.id).toBe(activeExec.id);
      expect(repo.listByAgentSessionId(sessionId).map((e) => e.id)).toEqual([
        activeExec.id,
        idleExec.id,
      ]);
    });
  });

  describe('delete', () => {
    it('deletes a node execution', () => {
      const exec = createExecution();
      expect(repo.delete(exec.id)).toBe(true);
      expect(repo.getById(exec.id)).toBeNull();
    });

    it('returns false for unknown ID', () => {
      expect(repo.delete('nonexistent')).toBe(false);
    });

    it('removes the execution from listByWorkflowRun', () => {
      const exec = createExecution();
      expect(repo.listByWorkflowRun(workflowRunId)).toHaveLength(1);
      repo.delete(exec.id);
      expect(repo.listByWorkflowRun(workflowRunId)).toHaveLength(0);
    });

    it('removes the execution from listByNode', () => {
      const exec = createExecution({ workflowNodeId: 'node-X' });
      expect(repo.listByNode(workflowRunId, 'node-X')).toHaveLength(1);
      repo.delete(exec.id);
      expect(repo.listByNode(workflowRunId, 'node-X')).toHaveLength(0);
    });
  });

  describe('deleteByWorkflowRun', () => {
    it('deletes all node executions for a workflow run', () => {
      createExecution({ workflowNodeId: 'node-1', agentName: 'coder' });
      createExecution({ workflowNodeId: 'node-1', agentName: 'reviewer' });
      createExecution({ workflowNodeId: 'node-2', agentName: 'qa' });

      expect(repo.listByWorkflowRun(workflowRunId)).toHaveLength(3);
      repo.deleteByWorkflowRun(workflowRunId);
      expect(repo.listByWorkflowRun(workflowRunId)).toHaveLength(0);
    });

    it('does not affect executions from other runs', () => {
      createExecution({ workflowNodeId: 'node-1', agentName: 'coder' });

      const run2 = runRepo.createRun({ spaceId, workflowId, title: 'Run #2' });
      createExecution({
        workflowRunId: run2.id,
        workflowNodeId: 'node-1',
        agentName: 'reviewer',
      });

      repo.deleteByWorkflowRun(workflowRunId);
      expect(repo.listByWorkflowRun(workflowRunId)).toHaveLength(0);
      expect(repo.listByWorkflowRun(run2.id)).toHaveLength(1);
    });

    it('is idempotent for runs with no executions', () => {
      const run2 = runRepo.createRun({ spaceId, workflowId, title: 'Run #2' });
      expect(() => repo.deleteByWorkflowRun(run2.id)).not.toThrow();
    });
  });

  describe('FK cascade behavior', () => {
    it('cascades delete when workflow run is deleted', () => {
      const exec = createExecution();
      expect(repo.getById(exec.id)).not.toBeNull();

      runRepo.deleteRun(workflowRunId);
      expect(repo.getById(exec.id)).toBeNull();
      expect(repo.listByWorkflowRun(workflowRunId)).toHaveLength(0);
    });

    it('sets agentId to null when agent is deleted (FK SET NULL)', () => {
      const exec = createExecution({ agentId });
      expect(exec.agentId).toBe(agentId);

      (db as any).prepare(`DELETE FROM space_agents WHERE id = ?`).run(agentId);

      const updated = repo.getById(exec.id)!;
      expect(updated.agentId).toBeNull();
    });
  });

  describe('status transitions and timestamp stamping', () => {
    it('full lifecycle: pending → in_progress → idle', () => {
      const exec = createExecution();
      expect(exec.status).toBe('pending');
      expect(exec.startedAt).toBeNull();
      expect(exec.completedAt).toBeNull();

      const started = repo.updateStatus(exec.id, 'in_progress')!;
      expect(started.status).toBe('in_progress');
      expect(started.startedAt).not.toBeNull();
      expect(started.completedAt).toBeNull();

      const completed = repo.updateStatus(started.id, 'idle')!;
      expect(completed.status).toBe('idle');
      expect(completed.startedAt).toBe(started.startedAt);
      expect(completed.completedAt).not.toBeNull();
    });

    it('re-entry to in_progress re-stamps startedAt', () => {
      const exec = createExecution();
      const first = repo.updateStatus(exec.id, 'in_progress')!;
      const firstStartedAt = first.startedAt;

      repo.updateStatus(exec.id, 'blocked');
      const reentry = repo.updateStatus(exec.id, 'in_progress')!;

      expect(reentry.status).toBe('in_progress');
      expect(reentry.startedAt).not.toBeNull();
      expect(reentry.startedAt).toBeGreaterThanOrEqual(firstStartedAt!);
    });
  });

  describe('multi-agent node support', () => {
    it('supports multiple agent slots on the same node', () => {
      createExecution({ workflowNodeId: 'review-node', agentName: 'strict-reviewer' });
      createExecution({ workflowNodeId: 'review-node', agentName: 'quick-reviewer' });

      const nodeExecs = repo.listByNode(workflowRunId, 'review-node');
      expect(nodeExecs).toHaveLength(2);
      const names = nodeExecs.map((e) => e.agentName).sort();
      expect(names).toEqual(['quick-reviewer', 'strict-reviewer']);
    });

    it('allows same agent on different nodes', () => {
      const nodeA = createExecution({ workflowNodeId: 'node-A', agentName: 'coder' });
      const nodeB = createExecution({ workflowNodeId: 'node-B', agentName: 'coder' });

      expect(nodeA.id).not.toBe(nodeB.id);
      expect(nodeA.workflowNodeId).toBe('node-A');
      expect(nodeB.workflowNodeId).toBe('node-B');
    });
  });

  describe('lastActivityAt / touchLastActivity', () => {
    it('create initializes lastActivityAt to null (no activity yet)', () => {
      const exec = createExecution();
      expect(exec.lastActivityAt).toBeNull();
    });

    it('createOrIgnore initializes lastActivityAt to null', () => {
      const exec = repo.createOrIgnore({
        workflowRunId,
        workflowNodeId: 'node-ci',
        agentName: 'ci',
        agentId,
      });
      expect(exec.lastActivityAt).toBeNull();
    });

    it('transition to in_progress does NOT auto-stamp lastActivityAt', () => {
      const exec = createExecution();
      const updated = repo.update(exec.id, { status: 'in_progress' });
      expect(updated!.lastActivityAt).toBeNull();
    });

    it('touchLastActivity advances last_activity_at', () => {
      const exec = createExecution();
      const stampedAt = 1_700_000_000_000;
      repo.touchLastActivity(exec.id, stampedAt);
      expect(repo.getById(exec.id)!.lastActivityAt).toBe(stampedAt);
    });

    it('touchLastActivity does NOT bump updated_at (state-write semantic preserved)', () => {
      const exec = createExecution();
      const originalUpdatedAt = exec.updatedAt;

      repo.touchLastActivity(exec.id, 1_700_000_000_000);
      const after = repo.getById(exec.id)!;
      expect(after.lastActivityAt).toBe(1_700_000_000_000);
      expect(after.updatedAt).toBe(originalUpdatedAt);
    });

    it('update({ lastActivityAt }) sets the field explicitly', () => {
      const exec = createExecution();
      const explicit = 5_000_000;
      const updated = repo.update(exec.id, { lastActivityAt: explicit });
      expect(updated!.lastActivityAt).toBe(explicit);
    });

    it('update({ lastActivityAt: null }) clears the field', () => {
      const exec = createExecution();
      repo.touchLastActivity(exec.id, 9_000_000);
      expect(repo.getById(exec.id)!.lastActivityAt).toBe(9_000_000);
      const updated = repo.update(exec.id, { lastActivityAt: null });
      expect(updated!.lastActivityAt).toBeNull();
    });

    it('touchLastActivity is a silent no-op for an unknown id', () => {
      expect(() => repo.touchLastActivity('nonexistent', 1_000)).not.toThrow();
    });

    it('round-trips lastActivityAt through listByWorkflowRun', () => {
      const exec = createExecution({ agentName: 'coder' });
      repo.touchLastActivity(exec.id, 7_777_777);
      const fetched = repo.listByWorkflowRun(workflowRunId).find((e) => e.id === exec.id)!;
      expect(fetched.lastActivityAt).toBe(7_777_777);
    });
  });

  describe('LiveQuery notifyChange', () => {
    function makeReactiveRepo() {
      const calls: Array<{ table: string; scope?: unknown }> = [];
      const reactiveDb = {
        notifyChange: (table: string, scope?: unknown) => calls.push({ table, scope }),
      };
      return {
        repo: new NodeExecutionRepository(
          db as unknown as Parameters<typeof NodeExecutionRepository.prototype.constructor>[0],
          reactiveDb as unknown as Parameters<
            typeof NodeExecutionRepository.prototype.constructor
          >[1]
        ),
        calls,
      };
    }

    it('touchLastActivity notifies node_executions so LiveQuery re-evaluates', () => {
      const { repo: r, calls } = makeReactiveRepo();
      const exec = createExecution();
      r.touchLastActivity(exec.id, 1_700_000_000_000);
      expect(calls).toEqual([{ table: 'node_executions', scope: undefined }]);
    });

    it('update() notifies node_executions on a real change', () => {
      const { repo: r, calls } = makeReactiveRepo();
      const exec = createExecution();
      r.update(exec.id, { status: 'in_progress' });
      expect(calls.some((c) => c.table === 'node_executions')).toBe(true);
    });

    it('create notifies node_executions', () => {
      const { repo: r, calls } = makeReactiveRepo();
      r.create({ workflowRunId, workflowNodeId: 'n-notify', agentName: 'coder', agentId });
      expect(calls.some((c) => c.table === 'node_executions')).toBe(true);
    });

    it('notify is a silent no-op when no reactive db is wired', () => {
      const exec = createExecution();
      expect(() => repo.touchLastActivity(exec.id, 1)).not.toThrow();
      expect(() => repo.update(exec.id, { status: 'idle' })).not.toThrow();
    });
  });
});
