import { describe, expect, test } from 'bun:test';
import type { NodeExecutionStatus, WorkflowNode } from '@hyperneo/shared';
import {
  type ActivationRoutingDecision,
  type ActivationRoutingInput,
  decideActivationRouting,
  selectWorkflowNodeForAgent,
} from '../../../../src/lib/space/runtime/activation-routing';

const ALL_STATUSES: NodeExecutionStatus[] = [
  'pending',
  'in_progress',
  'idle',
  'waiting_rebind',
  'blocked',
  'cancelled',
];

const ACTIVATION_STATUSES: NodeExecutionStatus[] = ['in_progress', 'blocked'];

function decide(overrides: Partial<ActivationRoutingInput> = {}): ActivationRoutingDecision {
  return decideActivationRouting({
    existingExecution: null,
    workflowNodeId: undefined,
    agentDeclaredOnNode: true,
    taskRunWorkflowResolvable: true,
    executionResolvable: true,
    ...overrides,
  });
}

describe('decideActivationRouting — existing-execution decision table', () => {
  for (const status of ALL_STATUSES) {
    const isActivationStatus = ACTIVATION_STATUSES.includes(status);

    test(`${status} + live session → ${isActivationStatus ? 'reuse_existing' : 'spawn_with_timeout'}`, () => {
      expect(
        decide({
          existingExecution: { status, agentSessionId: 'session-1', sessionAlive: true },
        })
      ).toEqual(
        isActivationStatus
          ? { action: 'reuse_existing', sessionId: 'session-1' }
          : { action: 'spawn_with_timeout' }
      );
    });

    test(`${status} + dead session → ${isActivationStatus ? 'reset_pending_and_continue' : 'spawn_with_timeout'}`, () => {
      expect(
        decide({
          existingExecution: { status, agentSessionId: 'session-1', sessionAlive: false },
        })
      ).toEqual(
        isActivationStatus
          ? { action: 'reset_pending_and_continue' }
          : { action: 'spawn_with_timeout' }
      );
    });

    test(`${status} + no session id → ${isActivationStatus ? 'reset_pending_and_continue' : 'spawn_with_timeout'}`, () => {
      expect(
        decide({
          existingExecution: { status, agentSessionId: null, sessionAlive: false },
        })
      ).toEqual(
        isActivationStatus
          ? { action: 'reset_pending_and_continue' }
          : { action: 'spawn_with_timeout' }
      );
    });
  }

  test('a live session without a session id cannot be reused', () => {
    expect(
      decide({
        existingExecution: { status: 'in_progress', agentSessionId: null, sessionAlive: true },
      })
    ).toEqual({ action: 'reset_pending_and_continue' });
  });

  test('an empty session id is treated as absent', () => {
    expect(
      decide({
        existingExecution: { status: 'blocked', agentSessionId: '', sessionAlive: true },
      })
    ).toEqual({ action: 'reset_pending_and_continue' });
  });

  test('a missing existing execution falls through to the spawn path', () => {
    expect(decide({ existingExecution: null })).toEqual({ action: 'spawn_with_timeout' });
    expect(decide({ existingExecution: undefined })).toEqual({ action: 'spawn_with_timeout' });
  });
});

describe('decideActivationRouting — node declaration gate', () => {
  test('an undeclared agent on the requested node is rejected', () => {
    expect(decide({ workflowNodeId: 'node-review', agentDeclaredOnNode: false })).toEqual({
      action: 'reject_undeclared',
    });
  });

  test('a declared agent on the requested node continues to spawn', () => {
    expect(decide({ workflowNodeId: 'node-review', agentDeclaredOnNode: true })).toEqual({
      action: 'spawn_with_timeout',
    });
  });

  test('the declaration gate only applies when a workflow node id is given', () => {
    expect(decide({ workflowNodeId: undefined, agentDeclaredOnNode: false })).toEqual({
      action: 'spawn_with_timeout',
    });
  });

  test('an omitted declaration fact does not reject', () => {
    expect(decide({ workflowNodeId: 'node-review', agentDeclaredOnNode: undefined })).toEqual({
      action: 'spawn_with_timeout',
    });
  });
});

describe('decideActivationRouting — post-activation gates', () => {
  test('an unresolvable task/run/workflow context returns empty', () => {
    expect(decide({ taskRunWorkflowResolvable: false })).toEqual({ action: 'return_empty' });
  });

  test('a missing execution after activation returns empty', () => {
    expect(decide({ executionResolvable: false })).toEqual({ action: 'return_empty' });
  });

  test('an unresolvable context returns empty even when an execution exists', () => {
    expect(decide({ taskRunWorkflowResolvable: false, executionResolvable: true })).toEqual({
      action: 'return_empty',
    });
  });

  test('a resolvable context with an execution routes to the timed spawn', () => {
    expect(decide({ taskRunWorkflowResolvable: true, executionResolvable: true })).toEqual({
      action: 'spawn_with_timeout',
    });
  });

  test('the post-activation shell shape omits the earlier facts entirely', () => {
    expect(
      decideActivationRouting({ taskRunWorkflowResolvable: true, executionResolvable: false })
    ).toEqual({ action: 'return_empty' });
    expect(decideActivationRouting({})).toEqual({ action: 'spawn_with_timeout' });
  });
});

describe('decideActivationRouting — precedence', () => {
  test('reuse_existing beats reject_undeclared', () => {
    expect(
      decide({
        existingExecution: {
          status: 'in_progress',
          agentSessionId: 'session-1',
          sessionAlive: true,
        },
        workflowNodeId: 'node-review',
        agentDeclaredOnNode: false,
      })
    ).toEqual({ action: 'reuse_existing', sessionId: 'session-1' });
  });

  test('reuse_existing beats return_empty', () => {
    expect(
      decide({
        existingExecution: { status: 'blocked', agentSessionId: 'session-1', sessionAlive: true },
        taskRunWorkflowResolvable: false,
        executionResolvable: false,
      })
    ).toEqual({ action: 'reuse_existing', sessionId: 'session-1' });
  });

  test('the reuse evaluation needs no declaration fact, so it cannot reject or throw on one', () => {
    expect(
      decideActivationRouting({
        existingExecution: {
          status: 'in_progress',
          agentSessionId: 'session-1',
          sessionAlive: true,
        },
      })
    ).toEqual({ action: 'reuse_existing', sessionId: 'session-1' });
  });

  test('a stale execution yields reset_pending_and_continue even when the agent is undeclared', () => {
    expect(
      decide({
        existingExecution: {
          status: 'in_progress',
          agentSessionId: 'session-1',
          sessionAlive: false,
        },
        workflowNodeId: 'node-review',
        agentDeclaredOnNode: false,
      })
    ).toEqual({ action: 'reset_pending_and_continue' });
  });

  test('the post-reset continuation with the existing execution cleared still rejects an undeclared agent', () => {
    expect(
      decideActivationRouting({
        existingExecution: null,
        workflowNodeId: 'node-review',
        agentDeclaredOnNode: false,
        taskRunWorkflowResolvable: true,
        executionResolvable: true,
      })
    ).toEqual({ action: 'reject_undeclared' });
  });

  test('reset_pending_and_continue beats return_empty and spawn', () => {
    expect(
      decide({
        existingExecution: { status: 'in_progress', agentSessionId: null, sessionAlive: false },
        taskRunWorkflowResolvable: false,
        executionResolvable: false,
      })
    ).toEqual({ action: 'reset_pending_and_continue' });
  });

  test('reject_undeclared short-circuits spawn when a node id is given', () => {
    expect(
      decide({
        workflowNodeId: 'node-review',
        agentDeclaredOnNode: false,
        taskRunWorkflowResolvable: true,
        executionResolvable: true,
      })
    ).toEqual({ action: 'reject_undeclared' });
  });

  test('reject_undeclared beats return_empty', () => {
    expect(
      decide({
        workflowNodeId: 'node-review',
        agentDeclaredOnNode: false,
        taskRunWorkflowResolvable: false,
        executionResolvable: false,
      })
    ).toEqual({ action: 'reject_undeclared' });
  });
});

describe('decideActivationRouting — pass-through identity', () => {
  test('reuse_existing carries the existing session id through unchanged', () => {
    const sessionId = 'space:s1:task:t1:exec:e1';
    const decision = decide({
      existingExecution: { status: 'in_progress', agentSessionId: sessionId, sessionAlive: true },
    });
    expect(decision).toEqual({ action: 'reuse_existing', sessionId });
    if (decision.action === 'reuse_existing') {
      expect(decision.sessionId).toBe(sessionId);
    }
  });
});

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'node-coder',
    name: 'coder',
    agents: [{ agentId: 'agent-coder', name: 'coder' }],
    ...overrides,
  } as unknown as WorkflowNode;
}

describe('selectWorkflowNodeForAgent', () => {
  test('returns the first node whose slots contain the agent', () => {
    const first = makeNode();
    const second = makeNode({ id: 'node-coder-2', name: 'coder-2' });
    expect(selectWorkflowNodeForAgent([first, second], 'coder')).toBe(first);
  });

  test('scans past nodes that do not declare the agent', () => {
    const other = makeNode({
      id: 'node-review',
      name: 'review',
      agents: [{ agentId: 'a', name: 'reviewer' }],
    });
    const target = makeNode();
    expect(selectWorkflowNodeForAgent([other, target], 'coder')).toBe(target);
  });

  test('honors the workflowNodeId filter', () => {
    const first = makeNode();
    const second = makeNode({ id: 'node-coder-2', name: 'coder-2' });
    expect(selectWorkflowNodeForAgent([first, second], 'coder', 'node-coder-2')).toBe(second);
  });

  test('returns null when the filtered node is not the one declaring the agent', () => {
    const first = makeNode();
    const other = makeNode({
      id: 'node-review',
      name: 'review',
      agents: [{ agentId: 'a', name: 'reviewer' }],
    });
    expect(selectWorkflowNodeForAgent([first, other], 'coder', 'node-review')).toBeNull();
  });

  test('without a filter the first declaring node wins', () => {
    const first = makeNode();
    expect(selectWorkflowNodeForAgent([first], 'coder', undefined)).toBe(first);
  });

  test('skips nodes whose slots cannot be resolved', () => {
    const broken = makeNode({ id: 'node-broken', name: 'broken', agents: [] });
    const target = makeNode();
    expect(selectWorkflowNodeForAgent([broken, target], 'coder')).toBe(target);
  });

  test('resolves legacy single-agent nodes by node name', () => {
    const legacy = makeNode({
      id: 'node-legacy',
      name: 'reviewer',
      agents: [],
      agentId: 'agent-legacy',
    });
    expect(selectWorkflowNodeForAgent([legacy], 'reviewer')).toBe(legacy);
  });

  test('returns null when no node declares the agent or all fail to resolve', () => {
    const broken = makeNode({ agents: [] });
    const other = makeNode({
      id: 'node-review',
      name: 'review',
      agents: [{ agentId: 'a', name: 'reviewer' }],
    });
    expect(selectWorkflowNodeForAgent([broken, other], 'coder')).toBeNull();
    expect(selectWorkflowNodeForAgent([], 'coder')).toBeNull();
  });
});
