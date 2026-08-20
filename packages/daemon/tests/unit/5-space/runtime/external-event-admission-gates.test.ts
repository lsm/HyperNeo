import { describe, expect, test } from 'bun:test';
import type { NodeExecution, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service';
import {
  buildQueueKey,
  evaluateRequeueTaskLifecycle,
  hasAnyExecutionForTarget,
  hasTerminalExecutionForTarget,
  isPublishedExternalEventExpired,
  isQueuedExternalEventExpired,
  isWorkflowTargetOwnedBySpace,
  prepareExternalEventTask,
  resolveCurrentQueueableOrActiveExecution,
  resolveLiveDeliveryTarget,
  resolveSubscriptionTarget,
} from '../../../../src/lib/space/runtime/external-event-admission-gates';

function makeExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: 'exec-1',
    workflowRunId: 'run-1',
    workflowNodeId: 'node-1',
    agentName: 'coder',
    agentId: null,
    agentSessionId: null,
    status: 'pending',
    result: null,
    data: null,
    createdAt: 1_700_000_000_000,
    startedAt: null,
    completedAt: null,
    updatedAt: 1_700_000_000_001,
    lastActivityAt: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    workflowRunId: 'run-1',
    nodeId: 'node-1',
    agentName: 'coder',
    status: 'in_progress',
    ...overrides,
  } as SpaceTask;
}

function makeRun(overrides: Partial<SpaceWorkflowRun> = {}): SpaceWorkflowRun {
  return {
    id: 'run-1',
    spaceId: 'space-1',
    workflowId: 'wf-1',
    definitionVersion: null,
    title: 'Run',
    status: 'in_progress',
    createdAt: 1_700_000_000_000,
    startedAt: null,
    updatedAt: 1_700_000_000_000,
    completedAt: null,
    ...overrides,
  } as SpaceWorkflowRun;
}

function makePayload(
  overrides: Partial<ExternalEventPublishedPayload> = {}
): ExternalEventPublishedPayload {
  return {
    namespaceId: 'space-1',
    spaceId: 'space-1',
    eventId: 'evt-1',
    source: 'github',
    topic: 'github/lsm/neokai/pull_request/42.review_submitted',
    dedupeKey: 'dedupe-1',
    summary: 'PR review submitted',
    payload: {},
    occurredAt: 1_700_000_000_000,
    ingestedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('resolveCurrentQueueableOrActiveExecution', () => {
  const scope = { workflowRunId: 'run-1', nodeId: 'node-1', agentName: 'coder' };

  test('picks the most recent non-cancelled execution for the agent', () => {
    const executions = [
      makeExecution({ id: 'a', updatedAt: 100, createdAt: 100, status: 'cancelled' }),
      makeExecution({ id: 'b', updatedAt: 300, createdAt: 300, status: 'idle' }),
      makeExecution({ id: 'c', updatedAt: 200, createdAt: 200, status: 'in_progress' }),
      makeExecution({ id: 'd', updatedAt: 400, createdAt: 400, status: 'cancelled' }),
    ];
    const result = resolveCurrentQueueableOrActiveExecution(executions, scope);
    expect(result?.id).toBe('b');
  });

  test('excludes executions from other runs or nodes despite matching agent name', () => {
    const executions = [
      makeExecution({ id: 'foreign-run', workflowRunId: 'run-2', agentSessionId: 'session-x' }),
      makeExecution({ id: 'foreign-node', workflowNodeId: 'node-2', agentSessionId: 'session-y' }),
    ];
    expect(resolveCurrentQueueableOrActiveExecution(executions, scope)).toBeUndefined();
  });
});

describe('resolveSubscriptionTarget', () => {
  test('injects live session id when execution has one', () => {
    const executions = [makeExecution({ agentSessionId: 'session-1', status: 'idle' })];
    const target = {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    };
    const result = resolveSubscriptionTarget(executions, target);
    expect(result.sessionId).toBe('session-1');
  });

  test('preserves input target when no live session exists', () => {
    const executions = [makeExecution({ agentSessionId: null })];
    const target = {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    };
    const result = resolveSubscriptionTarget(executions, target);
    expect('sessionId' in result).toBe(false);
    expect(result.taskId).toBe('task-1');
  });

  test('does not borrow a session from a foreign run or node', () => {
    const executions = [
      makeExecution({ workflowRunId: 'run-2', agentSessionId: 'session-x', status: 'idle' }),
      makeExecution({ workflowNodeId: 'node-2', agentSessionId: 'session-y', status: 'idle' }),
    ];
    const target = {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    };
    const result = resolveSubscriptionTarget(executions, target);
    expect('sessionId' in result).toBe(false);
  });
});

describe('resolveLiveDeliveryTarget', () => {
  test('returns null when there is no live session', () => {
    const executions = [makeExecution({ agentSessionId: null })];
    const target = {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    };
    expect(resolveLiveDeliveryTarget(executions, target)).toBeNull();
  });

  test('returns target with session id when live', () => {
    const executions = [makeExecution({ agentSessionId: 'session-2', status: 'idle' })];
    const target = {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    };
    const result = resolveLiveDeliveryTarget(executions, target);
    expect(result?.sessionId).toBe('session-2');
  });

  test('returns null instead of borrowing a session from a foreign run or node', () => {
    const executions = [
      makeExecution({ workflowRunId: 'run-2', agentSessionId: 'session-x', status: 'idle' }),
      makeExecution({ workflowNodeId: 'node-2', agentSessionId: 'session-y', status: 'idle' }),
    ];
    const target = {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    };
    expect(resolveLiveDeliveryTarget(executions, target)).toBeNull();
  });
});

describe('hasTerminalExecutionForTarget and hasAnyExecutionForTarget', () => {
  test('detects cancelled execution as terminal', () => {
    const executions = [makeExecution({ status: 'cancelled' })];
    expect(hasTerminalExecutionForTarget(executions, { agentName: 'coder' })).toBe(true);
  });

  test('detects any execution for the agent', () => {
    const executions = [makeExecution({ agentName: 'other' })];
    expect(hasAnyExecutionForTarget(executions, { agentName: 'coder' })).toBe(false);
    expect(hasAnyExecutionForTarget([makeExecution()], { agentName: 'coder' })).toBe(true);
  });
});

describe('isWorkflowTargetOwnedBySpace', () => {
  test('returns true when task and run belong to the same space and each other', () => {
    expect(isWorkflowTargetOwnedBySpace(makeTask(), makeRun(), 'space-1')).toBe(true);
  });

  test('returns false when task is from a different space', () => {
    expect(
      isWorkflowTargetOwnedBySpace(makeTask({ spaceId: 'space-2' }), makeRun(), 'space-1')
    ).toBe(false);
  });

  test('returns false when task does not match run', () => {
    expect(
      isWorkflowTargetOwnedBySpace(makeTask({ workflowRunId: 'run-2' }), makeRun(), 'space-1')
    ).toBe(false);
  });

  test('returns false when run is missing', () => {
    expect(isWorkflowTargetOwnedBySpace(makeTask(), null, 'space-1')).toBe(false);
  });
});

describe('prepareExternalEventTask', () => {
  test('delivers when ownership and lifecycle are valid', () => {
    const result = prepareExternalEventTask(makeTask(), makeRun(), makePayload());
    expect(result).toEqual({ action: 'deliver' });
  });

  test('fails when task is missing', () => {
    const result = prepareExternalEventTask(null, makeRun(), makePayload());
    expect(result).toEqual({ action: 'fail', reason: 'invalid_target_ownership' });
  });

  test('fails when run space does not match event space', () => {
    const result = prepareExternalEventTask(
      makeTask(),
      makeRun({ spaceId: 'space-2' }),
      makePayload()
    );
    expect(result).toEqual({ action: 'fail', reason: 'invalid_target_ownership' });
  });

  test('fails when task is terminal', () => {
    const result = prepareExternalEventTask(makeTask({ status: 'done' }), makeRun(), makePayload());
    expect(result).toEqual({ action: 'fail', reason: 'target_task_terminal' });
  });

  test('fails for cancelled and archived statuses', () => {
    expect(
      prepareExternalEventTask(makeTask({ status: 'cancelled' }), makeRun(), makePayload())
    ).toEqual({
      action: 'fail',
      reason: 'target_task_terminal',
    });
    expect(
      prepareExternalEventTask(makeTask({ status: 'archived' }), makeRun(), makePayload())
    ).toEqual({
      action: 'fail',
      reason: 'target_task_terminal',
    });
  });

  test('holds when task is stopped', () => {
    const result = prepareExternalEventTask(
      makeTask({ status: 'stopped' }),
      makeRun(),
      makePayload()
    );
    expect(result).toEqual({ action: 'hold' });
  });
});

describe('evaluateRequeueTaskLifecycle', () => {
  test('returns null when task is active', () => {
    expect(evaluateRequeueTaskLifecycle(makeTask(), { topic: 'a', source: 'b' })).toBeNull();
  });

  test('returns invalid_target_ownership when task is missing', () => {
    expect(evaluateRequeueTaskLifecycle(null, { topic: 'a', source: 'b' })).toBe(
      'invalid_target_ownership'
    );
  });

  test('returns target_task_terminal when task is done', () => {
    expect(
      evaluateRequeueTaskLifecycle(makeTask({ status: 'done' }), { topic: 'a', source: 'b' })
    ).toBe('target_task_terminal');
  });
});

describe('isPublishedExternalEventExpired and isQueuedExternalEventExpired', () => {
  test('published event is not expired when createdAt is missing', () => {
    expect(isPublishedExternalEventExpired(undefined, 1_700_000_000_000, 300_000)).toBe(false);
  });

  test('published event expires after ttl', () => {
    const now = 1_700_000_000_000;
    expect(isPublishedExternalEventExpired(now - 300_001, now, 300_000)).toBe(true);
    expect(isPublishedExternalEventExpired(now - 300_000, now, 300_000)).toBe(false);
  });

  test('queued event expires after ttl', () => {
    const now = 1_700_000_000_000;
    expect(isQueuedExternalEventExpired(now - 300_001, now, 300_000)).toBe(true);
    expect(isQueuedExternalEventExpired(now - 300_000, now, 300_000)).toBe(false);
  });

  test('uses default ttl when omitted', () => {
    const now = 1_700_000_000_000;
    expect(isQueuedExternalEventExpired(now - 300_001, now)).toBe(true);
  });
});

describe('buildQueueKey', () => {
  test('builds stable json queue key', () => {
    const target = {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    };
    expect(buildQueueKey(target)).toBe(JSON.stringify(['run-1', 'task-1', 'node-1', 'coder']));
  });
});
