/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test';
import type { ActorRef } from '../../../../../messaging/src/types.ts';
import {
  createDeliverTaskWorkerMessagePipeline,
  describeActor,
  describeAmbiguousTargetActors,
  describeTaskExecution,
  resolveHandleForTaskRouting,
  resolveNodeExecution,
  resolveWorkerTargetExecution,
} from '../../../../src/lib/space/actions/task-message-delivery.ts';

function nodeExecution(partial: {
  id: string;
  agentName: string;
  workflowNodeId: string;
  workflowRunId: string;
  agentSessionId?: string | null;
}) {
  return {
    id: partial.id,
    agentName: partial.agentName,
    workflowNodeId: partial.workflowNodeId,
    workflowRunId: partial.workflowRunId,
    agentSessionId: partial.agentSessionId ?? null,
    agentId: null,
    status: 'in_progress' as const,
    result: null,
    data: null,
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    updatedAt: 0,
    lastActivityAt: null,
  };
}

describe('resolveNodeExecution', () => {
  test('matches by id first', () => {
    const exec = nodeExecution({
      id: 'exec-1',
      agentName: 'coder',
      workflowNodeId: 'node-1',
      workflowRunId: 'run-1',
    });
    const result = resolveNodeExecution([exec], 'exec-1');
    expect(result).toBe(exec);
  });

  test('matches by normalized agent name', () => {
    const first = nodeExecution({
      id: 'exec-1',
      agentName: 'Coder',
      workflowNodeId: 'node-1',
      workflowRunId: 'run-1',
    });
    const last = nodeExecution({
      id: 'exec-2',
      agentName: 'CODER',
      workflowNodeId: 'node-1',
      workflowRunId: 'run-1',
    });
    const result = resolveNodeExecution([first, last], 'coder');
    expect(result).toBe(last);
  });

  test('returns null for empty selector', () => {
    const result = resolveNodeExecution([], '  ');
    expect(result).toBeNull();
  });
});

describe('resolveWorkerTargetExecution', () => {
  test('resolves @worker target to the last matching execution', () => {
    const first = nodeExecution({
      id: 'exec-1',
      agentName: 'coder',
      workflowNodeId: 'node-1',
      workflowRunId: 'run-1',
    });
    const last = nodeExecution({
      id: 'exec-2',
      agentName: 'coder',
      workflowNodeId: 'node-1',
      workflowRunId: 'run-1',
    });
    const result = resolveWorkerTargetExecution(
      [first, last],
      'run-1',
      new Map([['node-1', 'Node One']]),
      '@worker:run-1/Node%20One/coder'
    );
    expect(result).toBe(last);
  });

  test('rejects a worker target from a different run', () => {
    const exec = nodeExecution({
      id: 'exec-1',
      agentName: 'coder',
      workflowNodeId: 'node-1',
      workflowRunId: 'run-1',
    });
    const result = resolveWorkerTargetExecution(
      [exec],
      'run-2',
      new Map(),
      '@worker:run-1/node-1/coder'
    );
    expect(result).toBeNull();
  });

  test('rejects a worker target without an agent name', () => {
    const exec = nodeExecution({
      id: 'exec-1',
      agentName: 'coder',
      workflowNodeId: 'node-1',
      workflowRunId: 'run-1',
    });
    const result = resolveWorkerTargetExecution([exec], 'run-1', new Map(), '@worker:node-1');
    expect(result).toBeNull();
  });
});

describe('resolveHandleForTaskRouting', () => {
  function actor(overrides: Partial<ActorRef> = {}): ActorRef {
    return {
      actorId: 'agent:agent-1',
      kind: 'long-horizon',
      spaceId: 'space-1',
      status: 'active',
      handle: '@coder',
      roles: [],
      ...overrides,
    };
  }

  test('returns no-match for non-handle addresses', async () => {
    const result = await resolveHandleForTaskRouting(
      '@worker:run-1/node-1/coder',
      [],
      'space-1',
      'run-1'
    );
    expect(result).toEqual({ kind: 'no-match' });
  });

  test('returns task-worker when the execution matches and no actors resolve', async () => {
    const exec = nodeExecution({
      id: 'exec-1',
      agentName: 'coder',
      workflowNodeId: 'node-1',
      workflowRunId: 'run-1',
    });
    const result = await resolveHandleForTaskRouting('@coder', [exec], 'space-1', 'run-1');
    expect(result).toEqual({ kind: 'task-worker', exec });
  });

  test('returns long-horizon-agent when one actor resolves', async () => {
    const resolver = mock(async () => ({
      resolved: [
        {
          actor: actor({ actorId: 'agent:agent-1' }),
          targetRef: '@coder',
          address: { kind: 'handle' as const, handle: 'coder' },
        },
      ],
      unresolved: [],
    }));
    const result = await resolveHandleForTaskRouting('@coder', [], 'space-1', 'run-1', {
      resolveTargets: resolver,
    });
    expect(result).toEqual({
      kind: 'long-horizon-agent',
      actor: actor({ actorId: 'agent:agent-1' }),
    });
  });

  test('returns ambiguous when a task worker and a long-horizon actor both match', async () => {
    const exec = nodeExecution({
      id: 'exec-1',
      agentName: 'coder',
      workflowNodeId: 'node-1',
      workflowRunId: 'run-1',
    });
    const theActor = actor({ actorId: 'agent:agent-1' });
    const resolver = mock(async () => ({
      resolved: [
        {
          actor: theActor,
          targetRef: '@coder',
          address: { kind: 'handle' as const, handle: 'coder' },
        },
      ],
      unresolved: [],
    }));
    const result = await resolveHandleForTaskRouting('@coder', [exec], 'space-1', 'run-1', {
      resolveTargets: resolver,
    });
    expect(result).toEqual({ kind: 'ambiguous', actors: [theActor], exec });
  });
});

describe('describe helpers', () => {
  test('describeTaskExecution formats node and id', () => {
    const exec = nodeExecution({
      id: 'exec-1',
      agentName: 'coder',
      workflowNodeId: 'node-1',
      workflowRunId: 'run-1',
    });
    expect(describeTaskExecution(exec)).toBe('workflow node "coder" (exec-1)');
  });

  test('describeActor prefers handle', () => {
    const actor: ActorRef = {
      actorId: 'agent:agent-1',
      kind: 'long-horizon',
      spaceId: 'space-1',
      status: 'active',
      handle: '@coder',
      roles: [],
    };
    expect(describeActor(actor)).toBe('@coder (agent:agent-1)');
  });

  test('describeAmbiguousTargetActors joins actors and optional execution', () => {
    const exec = nodeExecution({
      id: 'exec-1',
      agentName: 'coder',
      workflowNodeId: 'node-1',
      workflowRunId: 'run-1',
    });
    const actor: ActorRef = {
      actorId: 'agent:agent-1',
      kind: 'long-horizon',
      spaceId: 'space-1',
      status: 'active',
      handle: '@coder',
      roles: [],
    };
    expect(describeAmbiguousTargetActors([actor], exec)).toBe(
      '- @coder (agent:agent-1)\n- workflow node "coder" (exec-1)'
    );
  });
});

describe('createDeliverTaskWorkerMessagePipeline', () => {
  const makeTask = () =>
    ({
      id: 'task-1',
      spaceId: 'space-1',
      taskNumber: 42,
      status: 'in_progress',
      priority: 'normal',
      title: 'Test task',
      description: null,
      createdAt: 0,
      updatedAt: 0,
      workflowRunId: 'run-1',
      dependsOn: [],
      metadata: {},
      result: null,
      reportedSummary: null,
      pendingCheckpointType: null,
      pendingCompletionGeneration: 0,
      ownerId: null,
      assignedAgent: null,
      customAgentId: null,
      workspacePath: null,
      checklist: [],
      tags: [],
    }) as unknown as import('../../../../src/lib/space/actions/task-message-delivery.ts').TaskWorkerDeliveryCtx['task'];

  function makeCtx(
    overrides: {
      resolved?: Partial<ReturnType<typeof nodeExecution>>;
      sessionSelector?: string;
      doorOutcome?: import('../../../../src/lib/space/actions/task-message-delivery.ts').TaskWorkerDeliveryCtx['doorOutcome'];
    } = {}
  ): import('../../../../src/lib/space/actions/task-message-delivery.ts').TaskWorkerDeliveryCtx {
    const { resolved: resolvedOverride, ...rest } = overrides;
    return {
      task: makeTask(),
      workflowRunId: 'run-1',
      resolved: nodeExecution({
        id: 'exec-1',
        agentName: 'coder',
        workflowNodeId: 'node-1',
        workflowRunId: 'run-1',
        agentSessionId: null,
        ...resolvedOverride,
      }) as unknown as import('../../../../src/lib/space/actions/task-message-delivery.ts').TaskWorkerDeliveryCtx['resolved'],
      message: 'hello',
      audit: mock(() => {}),
      ...rest,
    };
  }

  test('delivers to an existing session when injection succeeds', async () => {
    const injected = mock(async () => 'sdk-msg-1');
    const taskAgentManager = {
      injectSubSessionMessage: injected,
    } as unknown as import('../../../../src/lib/space/actions/task-message-delivery.ts').TaskWorkerDeliveryConfig['taskAgentManager'];
    const nodeExecutionRepo = {
      getById: () => null,
    } as unknown as import('../../../../src/lib/space/actions/task-message-delivery.ts').TaskWorkerDeliveryConfig['nodeExecutionRepo'];
    const pipeline = createDeliverTaskWorkerMessagePipeline({
      taskAgentManager,
      nodeExecutionRepo,
      outboundSenderLevel: 'session-agent',
      outboundSenderDisplayName: 'tester',
      outboundReplyTargetHandle: '@tester',
    });
    const ctx = makeCtx({ resolved: { agentSessionId: 'session-1' } });
    const result = await pipeline(ctx);
    expect(injected).toHaveBeenCalledWith('session-1', expect.any(String), true);
    expect(result.result?.content[0].text).toContain('sdk-msg-1');
    const parsed = JSON.parse(result.result?.content[0].text as string);
    expect(parsed.success).toBe(true);
    expect(parsed.delivered_session_id).toBe('session-1');
  });

  test('activates a node and then delivers to the refreshed session', async () => {
    const injected = mock(async (_sessionId: string) => 'sdk-msg-2');
    const taskAgentManager = {
      injectSubSessionMessage: injected,
    } as unknown as import('../../../../src/lib/space/actions/task-message-delivery.ts').TaskWorkerDeliveryConfig['taskAgentManager'];
    const refreshed = nodeExecution({
      id: 'exec-1',
      agentName: 'coder',
      workflowNodeId: 'node-1',
      workflowRunId: 'run-1',
      agentSessionId: 'session-2',
    });
    const nodeExecutionRepo = {
      getById: () => refreshed,
    } as unknown as import('../../../../src/lib/space/actions/task-message-delivery.ts').TaskWorkerDeliveryConfig['nodeExecutionRepo'];
    const activateNode = mock(async () => {});
    const ensureTargetSession = mock(async () => ({
      kind: 'unresolved' as const,
      reason: 'session_resolution_unavailable',
    }));
    const pipeline = createDeliverTaskWorkerMessagePipeline({
      taskAgentManager,
      nodeExecutionRepo,
      ensureTargetSession,
      activateNode,
      outboundSenderLevel: 'session-agent',
      outboundSenderDisplayName: 'tester',
      outboundReplyTargetHandle: '@tester',
    });
    const ctx = makeCtx({ resolved: { agentSessionId: null } });
    const result = await pipeline(ctx);
    expect(ensureTargetSession).toHaveBeenCalled();
    expect(activateNode).toHaveBeenCalledWith('run-1', 'node-1');
    expect(injected).toHaveBeenCalledWith('session-2', expect.any(String), true);
    const parsed = JSON.parse(result.result?.content[0].text as string);
    expect(parsed.success).toBe(true);
    expect(parsed.delivered_session_id).toBe('session-2');
  });

  test('reports activated without live session when no session appears', async () => {
    const injected = mock(async () => 'sdk-msg-3');
    const taskAgentManager = {
      injectSubSessionMessage: injected,
    } as unknown as import('../../../../src/lib/space/actions/task-message-delivery.ts').TaskWorkerDeliveryConfig['taskAgentManager'];
    const nodeExecutionRepo = {
      getById: () => null,
    } as unknown as import('../../../../src/lib/space/actions/task-message-delivery.ts').TaskWorkerDeliveryConfig['nodeExecutionRepo'];
    const activateNode = mock(async () => {});
    const ensureTargetSession = mock(async () => ({
      kind: 'unresolved' as const,
      reason: 'spawn_timeout',
    }));
    const pipeline = createDeliverTaskWorkerMessagePipeline({
      taskAgentManager,
      nodeExecutionRepo,
      ensureTargetSession,
      activateNode,
      outboundSenderLevel: 'session-agent',
      outboundSenderDisplayName: 'tester',
      outboundReplyTargetHandle: '@tester',
    });
    const ctx = makeCtx({ resolved: { agentSessionId: null } });
    const result = await pipeline(ctx);
    const parsed = JSON.parse(result.result?.content[0].text as string);
    expect(parsed.success).toBe(false);
    expect(parsed.activated).toBe(true);
    expect(parsed.delivered).toBe(false);
  });
});
