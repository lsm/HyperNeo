import { describe, expect, test } from 'bun:test';
import type { NodeExecution, SpaceWorkflow, WorkflowChannel } from '@hyperneo/shared';
import { ChannelResolver } from '../../../../src/lib/messaging/channel-resolver.ts';
import type {
  HookActionMeta,
  WorkflowHookEngine,
} from '../../../../src/lib/workflows/hook-engine.ts';
import type {
  NodeMessagingDependencies,
  NodeMessagingRuntime,
} from '../../../../src/lib/messaging/node-messaging-context.ts';
import { createNodeSendMessageOperation } from '../../../../src/lib/messaging/node-send-message.ts';
import type { AgentMessageParams } from '../../../../src/lib/messaging/agent-message-router.ts';
import type { AgentMessageResult } from '../../../../src/lib/messaging/routing-gates.ts';
import { isOperationAdmitted } from '../../../../src/lib/operations/invoke.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';

const RUN_ID = 'run-1';
const SPACE_ID = 'space-1';
const MY_SESSION = 'session-writer';

function execution(overrides: Partial<NodeExecution> & { agentName: string }): NodeExecution {
  return {
    id: `exec-${overrides.agentName}`,
    workflowRunId: RUN_ID,
    workflowNodeId: 'node-writer',
    agentId: null,
    agentSessionId: null,
    status: 'in_progress',
    result: null,
    data: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    updatedAt: 1,
    lastActivityAt: null,
    ...overrides,
  };
}

function workflowWith(channels: WorkflowChannel[]): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: SPACE_ID,
    name: 'Review Flow',
    description: '',
    nodes: [
      { id: 'node-writer', name: 'writer', agents: [{ name: 'writer' }] },
      { id: 'node-reviewer', name: 'reviewer', agents: [{ name: 'reviewer' }] },
    ],
    startNodeId: 'node-writer',
    channels,
    completionAutonomyLevel: 3,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SpaceWorkflow;
}

function executions(): NodeExecution[] {
  return [
    execution({ agentName: 'writer', agentSessionId: MY_SESSION }),
    execution({
      agentName: 'reviewer',
      workflowNodeId: 'node-reviewer',
      agentSessionId: 'session-reviewer',
    }),
  ];
}

interface Harness {
  deps: NodeMessagingDependencies;
  sent: AgentMessageParams[];
}

interface HookCall {
  method: string;
  args: Record<string, unknown>;
  meta: HookActionMeta;
}

function hookEngineStub(outcome: Record<string, unknown>, calls: HookCall[]): WorkflowHookEngine {
  return {
    executeAction: async (method: string, args: Record<string, unknown>, meta: HookActionMeta) => {
      calls.push({ method, args, meta });
      return outcome;
    },
    persistStateUpdate: () => true,
    clearQueuedRetryableActionsForOwner: () => [],
    clearQueuedRetryableActionsForKey: () => {},
    isRetryableActionCancelled: () => false,
  } as unknown as WorkflowHookEngine;
}

function harness(options: {
  deliver?: (params: AgentMessageParams) => AgentMessageResult;
  runtime?: boolean;
  sessionStatus?: string;
  workflow?: SpaceWorkflow;
  hookEngine?: WorkflowHookEngine;
}): Harness {
  const sent: AgentMessageParams[] = [];
  const workflow =
    options.workflow ?? workflowWith([{ from: 'writer', to: 'reviewer' } as WorkflowChannel]);
  const runtime: NodeMessagingRuntime = {
    spaceId: SPACE_ID,
    taskId: 'task-1',
    workflow,
    channelResolver: new ChannelResolver(workflow.channels ?? []),
    hookEngine: options.hookEngine,
    agentMessageRouter: {
      deliverMessage: async (params) => {
        sent.push(params);
        return (
          options.deliver?.(params) ?? {
            success: true,
            delivered: [{ agentName: 'reviewer', sessionId: 'session-reviewer' }],
            failed: [],
          }
        );
      },
    },
  };
  const rows = executions();
  return {
    sent,
    deps: {
      nodeExecutionRepo: {
        getByAgentSessionId: (sessionId) =>
          rows.find((row) => row.agentSessionId === sessionId) ?? null,
        listByNode: (runId, nodeId) =>
          rows.filter((row) => row.workflowRunId === runId && row.workflowNodeId === nodeId),
        listByWorkflowRun: (runId) => rows.filter((row) => row.workflowRunId === runId),
      },
      runtimeForSession: () => (options.runtime === false ? null : runtime),
      getSession: () => ({ status: options.sessionStatus ?? 'active' }),
    },
  };
}

const workerCaller: OperationCaller = {
  source: 'mcp',
  sessionId: MY_SESSION,
  spaceId: SPACE_ID,
  role: 'workflow_worker',
  agentName: 'writer',
};

describe('createNodeSendMessageOperation', () => {
  test('routes delivery with the sender identity taken from the caller session', async () => {
    const { deps, sent } = harness({});
    const operation = createNodeSendMessageOperation(deps);

    const result = (await operation.execute(
      { target: 'reviewer', message: 'please review' },
      workerCaller
    )) as { success: true; delivered: Array<{ agentName: string }>; message: string };

    expect(sent).toHaveLength(1);
    expect(sent[0]?.fromAgentName).toBe('writer');
    expect(sent[0]?.fromSessionId).toBe(MY_SESSION);
    expect(sent[0]?.message).toBe('please review');
    expect(result.success).toBe(true);
    expect(result.delivered).toEqual([{ agentName: 'reviewer', sessionId: 'session-reviewer' }]);
    expect(result.message).toContain('delivered to 1 peer(s)');
  });

  test('passes the structured data payload through to the router', async () => {
    const { deps, sent } = harness({});
    const operation = createNodeSendMessageOperation(deps);

    await operation.execute(
      { target: 'reviewer', message: 'ping', data: { prUrl: 'https://example.test/pr/1' } },
      workerCaller
    );

    expect(sent[0]?.data).toEqual({ prUrl: 'https://example.test/pr/1' });
  });

  test('reports a partial delivery with its failures and reason', async () => {
    const { deps } = harness({
      deliver: () => ({
        success: 'partial',
        delivered: [{ agentName: 'reviewer', sessionId: 'session-reviewer' }],
        failed: [{ agentName: 'ghost', sessionId: 'session-ghost', error: 'no session' }],
        reason: 'one target was unreachable',
      }),
    });
    const operation = createNodeSendMessageOperation(deps);

    const result = (await operation.execute(
      { target: 'reviewer', message: 'ping' },
      workerCaller
    )) as { success: string; failed: Array<{ agentName: string }>; message: string };

    expect(result.success).toBe('partial');
    expect(result.failed).toEqual([
      { agentName: 'ghost', sessionId: 'session-ghost', error: 'no session' },
    ]);
    expect(result.message).toContain('Reason: one target was unreachable');
  });

  test('rejects an unknown target during topology translation without delivering', async () => {
    const { deps, sent } = harness({});
    const operation = createNodeSendMessageOperation(deps);

    const result = (await operation.execute(
      { target: 'auditor', message: 'ping' },
      workerCaller
    )) as { success: false; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown target "auditor".');
    expect(sent).toHaveLength(0);
  });

  test('surfaces a router-reported unauthorized target with its permitted targets', async () => {
    const { deps } = harness({
      deliver: () => ({
        success: false,
        delivered: [],
        failed: [],
        reason: 'Target not permitted by channel topology.',
        unauthorizedAgentNames: ['reviewer'],
        permittedTargets: ['editor'],
      }),
    });
    const operation = createNodeSendMessageOperation(deps);

    const result = (await operation.execute(
      { target: 'reviewer', message: 'ping' },
      workerCaller
    )) as { success: false; error: string; permittedTargets: string[] };

    expect(result.success).toBe(false);
    expect(result.error).toBe('Target not permitted by channel topology.');
    expect(result.permittedTargets).toEqual(['editor']);
  });

  test('rejects an MCP caller whose role is not workflow_worker without delivering', async () => {
    const { deps, sent } = harness({});
    const operation = createNodeSendMessageOperation(deps);

    const result = await operation.execute({ target: 'reviewer', message: 'ping' }, {
      ...workerCaller,
      role: 'ad_hoc_member',
    } as OperationCaller);

    expect(result).toBe('node_caller_denied');
    expect(sent).toHaveLength(0);
  });

  test('rejects an archived node session in the owning Space without delivering', async () => {
    const { deps, sent } = harness({ sessionStatus: 'archived' });
    const operation = createNodeSendMessageOperation(deps);

    const result = await operation.execute({ target: 'reviewer', message: 'ping' }, workerCaller);

    expect(result).toBe('node_caller_denied');
    expect(sent).toHaveLength(0);
  });

  test('rejects a caller whose Space differs from the run Space without delivering', async () => {
    const { deps, sent } = harness({});
    const operation = createNodeSendMessageOperation(deps);

    const result = await operation.execute(
      { target: 'reviewer', message: 'ping' },
      {
        ...workerCaller,
        spaceId: 'space-other',
      }
    );

    expect(result).toBe('node_caller_denied');
    expect(sent).toHaveLength(0);
  });

  test('rejects a caller with no live node execution without delivering', async () => {
    const { deps, sent } = harness({ runtime: false });
    const operation = createNodeSendMessageOperation(deps);

    const result = await operation.execute({ target: 'reviewer', message: 'ping' }, workerCaller);

    expect(result).toBe('not_a_node_agent');
    expect(sent).toHaveLength(0);
  });

  test('keeps the send_message name so workflow hooks and templates keep binding', () => {
    const { deps } = harness({});

    expect(createNodeSendMessageOperation(deps).name).toBe('send_message');
  });

  test('declares a mutate policy, but the generic door no longer restricts it to workflow workers', () => {
    const { deps } = harness({});
    const operation = createNodeSendMessageOperation(deps);

    expect(operation.policy).toEqual({ safetyClass: 'mutate', roles: ['workflow_worker'] });
    expect(isOperationAdmitted(operation, workerCaller)).toBe(true);
    expect(isOperationAdmitted(operation, { ...workerCaller, role: 'long_term_agent' })).toBe(true);
  });

  test('refuses caller identity supplied through input', async () => {
    const { deps } = harness({});
    const operation = createNodeSendMessageOperation(deps);

    const parsed = operation.inputSchema.safeParse({
      target: 'reviewer',
      message: 'ping',
      myAgentName: 'reviewer',
      sessionId: 'session-reviewer',
    });

    expect(parsed.success).toBe(false);
  });
});

describe('createNodeSendMessageOperation workflow hooks', () => {
  test('runs send_message hooks with the resolved node meta and delivers the patched params', async () => {
    const calls: HookCall[] = [];
    const { deps, sent } = harness({
      hookEngine: hookEngineStub(
        {
          decision: 'allow',
          stateUpdates: [],
          executionLog: [],
          followUpRequests: [],
          userState: { status: 'patched' },
          finalParams: { target: 'reviewer', message: 'patched by hook' },
        },
        calls
      ),
    });
    const operation = createNodeSendMessageOperation(deps);

    await operation.execute({ target: 'reviewer', message: 'original' }, workerCaller);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('send_message');
    expect(calls[0]?.args).toEqual({ target: 'reviewer', message: 'original' });
    expect(calls[0]?.meta).toEqual({
      sessionId: MY_SESSION,
      agentName: 'writer',
      nodeId: 'node-writer',
      taskId: 'task-1',
    });
    expect(sent[0]?.message).toBe('patched by hook');
  });

  test('returns the hook block reason without delivering', async () => {
    const calls: HookCall[] = [];
    const { deps, sent } = harness({
      hookEngine: hookEngineStub(
        {
          decision: 'block',
          stateUpdates: [],
          executionLog: [],
          followUpRequests: [],
          userState: {
            status: 'blocked_by_hook',
            reason: 'gate not green',
            hookLabel: 'ci-gate',
          },
          finalParams: { target: 'reviewer', message: 'original' },
        },
        calls
      ),
    });
    const operation = createNodeSendMessageOperation(deps);

    const result = (await operation.execute(
      { target: 'reviewer', message: 'original' },
      workerCaller
    )) as { success: false; error: string; hookLabel: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('gate not green');
    expect(result.hookLabel).toBe('ci-gate');
    expect(sent).toHaveLength(0);
  });
});
