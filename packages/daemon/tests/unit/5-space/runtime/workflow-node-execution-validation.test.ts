import { describe, test, expect } from 'bun:test';
import type { WorkflowNode } from '@hyperneo/shared';
import type { NodeExecution, SpaceWorkflow } from '@hyperneo/shared';
import {
  findMissingNodeAgentReferences,
  formatMissingAgentReference,
  isMissingWorkflowAgentError,
  MissingWorkflowAgentError,
  PermanentSpawnError,
  validateExecutionAgainstWorkflow,
} from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';

function makeNode(
  agents: Array<{ agentId?: string | null; templateKey?: string; name: string }>
): WorkflowNode {
  return {
    id: 'node-1',
    name: 'Review',
    agents: agents as WorkflowNode['agents'],
  } as WorkflowNode;
}

describe('findMissingNodeAgentReferences', () => {
  test('returns [] when every configured agent exists', () => {
    const node = makeNode([{ agentId: 'a1', name: 'coder' }]);
    expect(findMissingNodeAgentReferences(node, () => true)).toEqual([]);
  });

  test('reports a configured custom agent that no longer exists', () => {
    const node = makeNode([{ agentId: 'gone', name: 'reviewer' }]);
    expect(findMissingNodeAgentReferences(node, (id) => id !== 'gone')).toEqual([
      { agentName: 'reviewer', agentId: 'gone' },
    ]);
  });

  test('reports only the missing slot among a mixed set', () => {
    const node = makeNode([
      { agentId: 'present', name: 'coder' },
      { agentId: 'gone', name: 'reviewer' },
    ]);
    expect(findMissingNodeAgentReferences(node, (id) => id !== 'gone')).toEqual([
      { agentName: 'reviewer', agentId: 'gone' },
    ]);
  });

  test('preserves built-in/worker slots with no agent id (null/empty)', () => {
    const node = makeNode([
      { agentId: null, name: 'worker-null' },
      { agentId: '', name: 'worker-empty' },
      { agentId: undefined, name: 'worker-undefined' },
    ]);
    expect(findMissingNodeAgentReferences(node, () => false)).toEqual([]);
  });
});

describe('MissingWorkflowAgentError', () => {
  test('is a PermanentSpawnError (terminal — no retry storm)', () => {
    const err = new MissingWorkflowAgentError('boom', {
      agentName: 'reviewer',
      agentId: 'gone',
    });
    expect(err).toBeInstanceOf(PermanentSpawnError);
    expect(err.permanent).toBe(true);
    expect(err.reference).toEqual({ agentName: 'reviewer', agentId: 'gone' });
    expect(isMissingWorkflowAgentError(err)).toBe(true);
    expect(isMissingWorkflowAgentError(new PermanentSpawnError('other'))).toBe(false);
  });
});

describe('validateExecutionAgainstWorkflow', () => {
  function makeExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
    return {
      id: 'exec-1',
      taskId: 'task-1',
      workflowRunId: 'run-1',
      workflowNodeId: 'node-1',
      agentName: 'coder',
      agentId: '',
      status: 'pending',
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    } as NodeExecution;
  }

  function makeWorkflow(agents: WorkflowNode['agents']): SpaceWorkflow {
    return {
      id: 'wf-1',
      spaceId: 'space-1',
      name: 'Test',
      nodes: [{ id: 'node-1', name: 'Review', agents }],
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as SpaceWorkflow;
  }

  test('is valid for a template-only slot', () => {
    const workflow = makeWorkflow([{ agentId: '', templateKey: 'coder.default', name: 'coder' }]);
    const result = validateExecutionAgainstWorkflow(makeExecution(), workflow);
    expect(result).toEqual({ valid: true });
  });

  test('is invalid when the slot has neither agentId nor templateKey', () => {
    const workflow = makeWorkflow([{ agentId: '', name: 'coder' }]);
    const result = validateExecutionAgainstWorkflow(makeExecution(), workflow);
    expect(result).toEqual({
      valid: false,
      reason: 'Agent slot coder no longer exists on workflow node node-1',
      permanent: true,
    });
  });

  test('whitespace templateKey falls back to agentId', () => {
    const workflow = makeWorkflow([{ agentId: 'agent-1', templateKey: '   ', name: 'coder' }]);
    const result = validateExecutionAgainstWorkflow(
      makeExecution({ agentId: 'agent-1' }),
      workflow
    );
    expect(result).toEqual({ valid: true });
  });

  test('templateKey takes precedence over stale agentId', () => {
    const workflow = makeWorkflow([
      { agentId: 'stale', templateKey: 'coder.default', name: 'coder' },
    ]);
    const result = validateExecutionAgainstWorkflow(
      makeExecution({ agentId: 'template:coder.default' }),
      workflow
    );
    expect(result).toEqual({ valid: true });
  });

  test('accepts a legacy execution identity migrated to a collision-suffixed template', () => {
    const workflow = makeWorkflow([
      { agentId: '', templateKey: 'migrated.agent.agent-1.m228', name: 'coder' },
    ]);
    const result = validateExecutionAgainstWorkflow(
      makeExecution({ agentId: 'agent-1' }),
      workflow
    );
    expect(result).toEqual({ valid: true });
  });

  test('accepts a legacy execution identity migrated to its matching template', () => {
    const workflow = makeWorkflow([
      { agentId: '', templateKey: 'migrated.agent.agent-1', name: 'coder' },
    ]);
    const result = validateExecutionAgainstWorkflow(
      makeExecution({ agentId: 'agent-1' }),
      workflow
    );
    expect(result).toEqual({ valid: true });
  });

  test('rejects a legacy execution identity migrated to another agent template', () => {
    const workflow = makeWorkflow([
      { agentId: '', templateKey: 'migrated.agent.agent-2', name: 'coder' },
    ]);
    const result = validateExecutionAgainstWorkflow(
      makeExecution({ agentId: 'agent-1' }),
      workflow
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.permanent).toBe(true);
  });

  test('rejects an unrelated template when execution carries a legacy identity', () => {
    const workflow = makeWorkflow([{ agentId: '', templateKey: 'coder.default', name: 'coder' }]);
    const result = validateExecutionAgainstWorkflow(
      makeExecution({ agentId: 'agent-1' }),
      workflow
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.permanent).toBe(true);
  });
});

describe('findMissingNodeAgentReferences template precedence', () => {
  test('skips agent-existence check when templateKey is present', () => {
    const node = makeNode([{ agentId: 'missing', templateKey: 'coder.default', name: 'coder' }]);
    expect(findMissingNodeAgentReferences(node, () => false)).toEqual([]);
  });

  test('still reports a missing agent when no templateKey is present', () => {
    const node = makeNode([{ agentId: 'missing', name: 'coder' }]);
    expect(findMissingNodeAgentReferences(node, () => false)).toEqual([
      { agentName: 'coder', agentId: 'missing' },
    ]);
  });

  test('skips check for whitespace-only templateKey', () => {
    const node = makeNode([{ agentId: 'missing', templateKey: '   ', name: 'coder' }]);
    expect(findMissingNodeAgentReferences(node, () => false)).toEqual([
      { agentName: 'coder', agentId: 'missing' },
    ]);
  });
});

describe('formatMissingAgentReference', () => {
  test('includes run id, target node, agent name, and stale agent id', () => {
    const message = formatMissingAgentReference({
      runId: 'run-123',
      nodeLabel: 'Review',
      agentName: 'reviewer',
      agentId: 'gone',
    });
    expect(message).toContain('run-123');
    expect(message).toContain('Review');
    expect(message).toContain('reviewer');
    expect(message).toContain('gone');
    expect(message).not.toMatch(/FOREIGN KEY/i);
  });
});
