import type { NodeExecution, Session, SpaceLongHorizonAgent, SpaceTask } from '@hyperneo/shared';
import { longTermAgentSessionId } from '../../../src/lib/space/long-term-agent-session.ts';
import type { SpaceMcpSessionPolicyContext } from '../../../src/lib/space/runtime/space-mcp-session-policy.ts';

export type SessionKind =
  | 'agent_card'
  | 'space_chat'
  | 'ad_hoc_member'
  | 'workflow_worker'
  | 'direct_task_worker'
  | 'non_space';

export const SESSION_KINDS: readonly SessionKind[] = [
  'agent_card',
  'space_chat',
  'ad_hoc_member',
  'workflow_worker',
  'direct_task_worker',
  'non_space',
];

export const SESSION_KIND_SPACE_ID = 'space-kinds-1';
export const SESSION_KIND_AGENT_ID = 'agent-kinds-1';
export const SESSION_KIND_TASK_ID = 'task-kinds-1';
export const SESSION_KIND_WORKFLOW_RUN_ID = 'run-kinds-1';
export const SESSION_KIND_NODE_ID = 'node-kinds-1';

const NOW = Date.now();

const SESSION_IDS: Record<SessionKind, string> = {
  agent_card: longTermAgentSessionId(SESSION_KIND_SPACE_ID, SESSION_KIND_AGENT_ID),
  space_chat: `space:chat:${SESSION_KIND_SPACE_ID}`,
  ad_hoc_member: 'session-ad-hoc-member',
  workflow_worker: 'session-workflow-worker',
  direct_task_worker: 'session-direct-task-worker',
  non_space: 'session-outside-any-space',
};

export function sessionIdForKind(kind: SessionKind): string {
  return SESSION_IDS[kind];
}

export function makeSessionOfKind(kind: SessionKind, overrides: Partial<Session> = {}): Session {
  const base: Session = {
    id: SESSION_IDS[kind],
    title: `Session (${kind})`,
    workspacePath: '/tmp/session-kinds-ws',
    createdAt: new Date(NOW).toISOString(),
    lastActiveAt: new Date(NOW).toISOString(),
    status: 'active',
    config: {},
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    type: 'worker',
  } as unknown as Session;

  const shaped: Session = { ...base, ...kindShape(kind), ...overrides } as Session;
  return shaped;
}

function kindShape(kind: SessionKind): Partial<Session> {
  switch (kind) {
    case 'agent_card':
      return {
        context: { spaceId: SESSION_KIND_SPACE_ID },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
          promptProvenance: {
            source: 'session-kinds-helper',
            hash: 'hash',
            agentId: SESSION_KIND_AGENT_ID,
            agentName: 'Card Agent',
          },
        },
      } as unknown as Partial<Session>;
    case 'space_chat':
      return {
        type: 'space_chat',
        context: { spaceId: SESSION_KIND_SPACE_ID },
      } as unknown as Partial<Session>;
    case 'ad_hoc_member':
      return { context: { spaceId: SESSION_KIND_SPACE_ID } } as unknown as Partial<Session>;
    case 'workflow_worker':
      return {
        context: { spaceId: SESSION_KIND_SPACE_ID, taskId: SESSION_KIND_TASK_ID },
      } as unknown as Partial<Session>;
    case 'direct_task_worker':
      return {
        context: { spaceId: SESSION_KIND_SPACE_ID, taskId: SESSION_KIND_TASK_ID },
      } as unknown as Partial<Session>;
    case 'non_space':
      return {};
  }
}

export function makeSessionKindLongHorizonAgent(
  overrides: Partial<SpaceLongHorizonAgent> = {}
): SpaceLongHorizonAgent {
  return {
    id: SESSION_KIND_AGENT_ID,
    spaceId: SESSION_KIND_SPACE_ID,
    handle: 'card-agent',
    displayName: 'Card Agent',
    templateKey: null,
    status: 'active',
    sessionId: null,
    instructions: '',
    autonomyLevel: 2,
    model: null,
    thinkingLevel: null,
    provider: null,
    settingSources: null,
    toolPermissions: { mode: 'inherit', tools: [] },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as SpaceLongHorizonAgent;
}

export function makeSessionKindNodeExecution(
  overrides: Partial<NodeExecution> = {}
): NodeExecution {
  return {
    id: 'exec-kinds-1',
    workflowRunId: SESSION_KIND_WORKFLOW_RUN_ID,
    workflowNodeId: SESSION_KIND_NODE_ID,
    agentName: 'coder',
    agentId: null,
    agentSessionId: SESSION_IDS.workflow_worker,
    status: 'in_progress',
    result: null,
    data: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: null,
    updatedAt: NOW,
    ...overrides,
  } as NodeExecution;
}

export function makeSessionKindTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: SESSION_KIND_TASK_ID,
    spaceId: SESSION_KIND_SPACE_ID,
    taskNumber: 1,
    title: 'Session kinds task',
    status: 'in_progress',
    workflowRunId: SESSION_KIND_WORKFLOW_RUN_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as SpaceTask;
}

export function makeSessionKindPolicyContext(kind: SessionKind): SpaceMcpSessionPolicyContext {
  const execution = makeSessionKindNodeExecution();
  return {
    hasDirectWorkerProvenance: (sessionId) =>
      kind === 'direct_task_worker' && sessionId === SESSION_IDS.direct_task_worker,
    resolveDirectWorker: () => null,
    nodeExecutionRepo: {
      getByAgentSessionId: (sessionId) =>
        kind === 'workflow_worker' && sessionId === SESSION_IDS.workflow_worker ? execution : null,
      getById: () => null,
    },
    taskRepo: { getTask: () => makeSessionKindTask() },
    longHorizonAgentRepo: {
      getById: (agentId) =>
        agentId === SESSION_KIND_AGENT_ID ? makeSessionKindLongHorizonAgent() : null,
    },
  };
}
