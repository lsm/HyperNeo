// @ts-nocheck

import type {
  NodeExecution,
  SpaceWorkerAgent,
  SpaceTask,
  SpaceTaskActivityMember,
  SpaceWorkflow,
  SpaceWorkflowRun,
} from '@hyperneo/shared';
import { signal } from '@preact/signals';
import { cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSpaceOverlaySessionIdSignal,
  mockSpaceOverlayAgentNameSignal,
  mockSpaceOverlayTaskContextSignal,
  mockCurrentSpaceTaskViewTabSignal,
  mockCurrentSpaceIdSignal,
  captured,
} = vi.hoisted(() => ({
  mockSpaceOverlaySessionIdSignal: { value: null as string | null },
  mockSpaceOverlayAgentNameSignal: { value: null as string | null },
  mockSpaceOverlayTaskContextSignal: {
    value: null as { taskId: string; agentName: string; nodeExecutionId?: string | null } | null,
  },
  mockCurrentSpaceTaskViewTabSignal: { value: 'thread' as string },
  mockCurrentSpaceIdSignal: { value: null as string | null },
  captured: { onSend: null as unknown },
}));

vi.mock('../TaskSessionChatComposer', () => ({
  TaskSessionChatComposer: ({ onSend }: { onSend: unknown }) => {
    captured.onSend = onSend;
    return <div data-testid="mock-task-session-chat-composer" />;
  },
}));

vi.mock('../../../lib/router', () => ({
  currentRoute: signal({ name: 'space-task' }),
  navigate: vi.fn(),
}));

vi.mock('../../../lib/signals', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    get spaceOverlaySessionIdSignal() {
      return mockSpaceOverlaySessionIdSignal;
    },
    get spaceOverlayAgentNameSignal() {
      return mockSpaceOverlayAgentNameSignal;
    },
    get spaceOverlayTaskContextSignal() {
      return mockSpaceOverlayTaskContextSignal;
    },
    get spaceOverlayPendingTaskIdSignal() {
      return { value: null };
    },
    get currentSpaceTaskViewTabSignal() {
      return mockCurrentSpaceTaskViewTabSignal;
    },
    get currentSpaceIdSignal() {
      return mockCurrentSpaceIdSignal;
    },
  };
});

let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockAgents: ReturnType<typeof signal<SpaceWorkerAgent[]>>;
let mockWorkflows: ReturnType<typeof signal<SpaceWorkflow[]>>;
let mockWorkflowRuns: ReturnType<typeof signal<SpaceWorkflowRun[]>>;
let mockTaskActivity: ReturnType<typeof signal<Map<string, SpaceTaskActivityMember[]>>>;
let mockNodeExecutions: ReturnType<typeof signal<NodeExecution[]>>;
let mockNodeExecutionsByNodeId: ReturnType<typeof signal<Map<string, unknown[]>>>;

const mockSendTaskMessage = vi.fn();
const mockEnsureTaskAgentSession = vi.fn();

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      tasks: mockTasks,
      agents: mockAgents,
      workflows: mockWorkflows,
      workflowRuns: mockWorkflowRuns,
      taskActivity: mockTaskActivity,
      nodeExecutions: mockNodeExecutions,
      nodeExecutionsByNodeId: mockNodeExecutionsByNodeId,
      updateTask: vi.fn(),
      recoverWorkflowTask: vi.fn(),
      submitForReview: vi.fn(),
      ensureTaskAgentSession: mockEnsureTaskAgentSession,
      sendTaskMessage: mockSendTaskMessage,
      subscribeTaskActivity: vi.fn().mockResolvedValue(undefined),
      unsubscribeTaskActivity: vi.fn(),
      ensureConfigData: vi.fn().mockResolvedValue(undefined),
      ensureNodeExecutions: vi.fn().mockResolvedValue(undefined),
      workflowVersions: signal(new Map()),
    };
  },
}));

vi.mock('../SpaceTaskUnifiedThread', () => ({
  SpaceTaskUnifiedThread: () => <div data-testid="space-task-unified-thread" />,
}));

vi.mock('../ReadOnlyWorkflowCanvas', () => ({
  ReadOnlyWorkflowCanvas: () => <div data-testid="workflow-canvas" />,
}));

vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

mockTasks = signal<SpaceTask[]>([]);
mockAgents = signal<SpaceWorkerAgent[]>([]);
mockWorkflows = signal<SpaceWorkflow[]>([]);
mockWorkflowRuns = signal<SpaceWorkflowRun[]>([]);
mockTaskActivity = signal<Map<string, SpaceTaskActivityMember[]>>(new Map());
mockNodeExecutions = signal<NodeExecution[]>([]);
mockNodeExecutionsByNodeId = signal<Map<string, unknown[]>>(new Map());

import { SpaceTaskPane } from '../SpaceTaskPane';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    taskNumber: 1,
    title: 'Fix the bug',
    description: 'Task description',
    status: 'in_progress',
    priority: 'normal',
    dependsOn: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    taskAgentSessionId: 'session-abc',
    ...overrides,
  };
}

describe('SpaceTaskPane — image passthrough', () => {
  beforeEach(() => {
    cleanup();
    captured.onSend = null;
    mockTasks.value = [makeTask()];
    mockSendTaskMessage.mockReset();
    mockSendTaskMessage.mockResolvedValue({ delivered: true });
    mockEnsureTaskAgentSession.mockReset();
    mockSpaceOverlaySessionIdSignal.value = null;
    mockSpaceOverlayAgentNameSignal.value = null;
    mockSpaceOverlayTaskContextSignal.value = null;
    mockCurrentSpaceTaskViewTabSignal.value = 'thread';
    mockCurrentSpaceIdSignal.value = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('forwards images from the composer to spaceStore.sendTaskMessage', async () => {
    render(<SpaceTaskPane taskId="task-1" />);

    await waitFor(() => expect(captured.onSend).toBeTruthy());

    const sampleImage = { media_type: 'image/png' as const, data: 'AAAAB' };
    const target = {
      id: 'node:n1:coder',
      kind: 'node_agent' as const,
      label: 'Coder',
      agentName: 'coder',
    };

    await (captured.onSend as Function)('check this screenshot', target, [sampleImage]);

    expect(mockSendTaskMessage).toHaveBeenCalledWith(
      'task-1',
      'check this screenshot',
      { kind: 'node_agent', agentName: 'coder' },
      [sampleImage],
      undefined
    );
  });

  it('passes undefined images when the composer fires onSend without attachments', async () => {
    render(<SpaceTaskPane taskId="task-1" />);

    await waitFor(() => expect(captured.onSend).toBeTruthy());

    const target = {
      id: 'node:n1:coder',
      kind: 'node_agent' as const,
      label: 'Coder',
      agentName: 'coder',
    };
    await (captured.onSend as Function)('plain text', target);

    expect(mockSendTaskMessage).toHaveBeenCalledWith(
      'task-1',
      'plain text',
      { kind: 'node_agent', agentName: 'coder' },
      undefined,
      undefined
    );
  });
});
