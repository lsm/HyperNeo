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
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSpaceOverlaySessionIdSignal,
  mockSpaceOverlayAgentNameSignal,
  mockSpaceOverlayTaskContextSignal,
  viewTabBridge,
  idBridge,
} = vi.hoisted(() => ({
  mockSpaceOverlaySessionIdSignal: { value: null as string | null },
  mockSpaceOverlayAgentNameSignal: { value: null as string | null },
  mockSpaceOverlayTaskContextSignal: {
    value: null as { taskId: string; agentName: string; nodeExecutionId?: string | null } | null,
  },
  viewTabBridge: { signal: null as ReturnType<typeof signal<string>> | null },
  idBridge: { signal: null as ReturnType<typeof signal<string | null>> | null },
}));

const {
  mockNavigateToSpaceAgent,
  mockPushOverlayHistory,
  mockPushOverlayHistoryForPendingAgent,
  mockNavigateToSpaceTask,
} = vi.hoisted(() => ({
  mockNavigateToSpaceAgent: vi.fn(),
  mockPushOverlayHistory: vi.fn(
    (
      sessionId: string,
      agentName?: string,
      _highlight?: string,
      taskContext?: { taskId: string; agentName: string; nodeExecutionId?: string | null } | null
    ) => {
      mockSpaceOverlaySessionIdSignal.value = sessionId;
      mockSpaceOverlayAgentNameSignal.value = agentName ?? null;
      mockSpaceOverlayTaskContextSignal.value = taskContext ?? null;
    }
  ),
  mockPushOverlayHistoryForPendingAgent: vi.fn(),
  mockNavigateToSpaceTask: vi.fn((_spaceId: string, _taskId: string, view: string) => {
    if (viewTabBridge.signal) {
      viewTabBridge.signal.value = view ?? 'thread';
    }
    if (idBridge.signal) {
      idBridge.signal.value = _spaceId;
    }
  }),
}));

const mockCurrentSpaceTaskViewTabSignal = signal<string>('thread');
const mockCurrentSpaceIdSignal = signal<string | null>(null);

viewTabBridge.signal = mockCurrentSpaceTaskViewTabSignal;
idBridge.signal = mockCurrentSpaceIdSignal;

vi.mock('../../../lib/router', () => ({
  navigateToSpaceAgent: mockNavigateToSpaceAgent,
  pushOverlayHistory: mockPushOverlayHistory,
  pushOverlayHistoryForPendingAgent: mockPushOverlayHistoryForPendingAgent,
  navigateToSpaceTask: mockNavigateToSpaceTask,
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
let mockTaskMessageActivity: ReturnType<typeof signal<Map<string, number>>>;
let mockNodeExecutions: ReturnType<typeof signal<NodeExecution[]>>;
let mockNodeExecutionsByNodeId: ReturnType<typeof signal<Map<string, unknown[]>>>;

const mockUpdateTask = vi.fn().mockResolvedValue(undefined);
const mockCancelWorkflowRun = vi.fn().mockResolvedValue(undefined);
const mockRecoverWorkflowTask = vi.fn().mockResolvedValue(undefined);
const mockSubmitForReview = vi.fn().mockResolvedValue(undefined);
const mockEnsureTaskAgentSession = vi.fn();
const mockSendTaskMessage = vi.fn().mockResolvedValue(undefined);
const mockSubscribeTaskActivity = vi.fn().mockResolvedValue(undefined);
const mockUnsubscribeTaskActivity = vi.fn();

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      tasks: mockTasks,
      agents: mockAgents,
      workflows: mockWorkflows,
      workflowRuns: mockWorkflowRuns,
      taskActivity: mockTaskActivity,
      taskMessageActivity: mockTaskMessageActivity,
      hasTaskMessageActivity: (id: string) => {
        const count = mockTaskMessageActivity.value.get(id);
        return count === undefined ? null : count > 0;
      },
      nodeExecutions: mockNodeExecutions,
      nodeExecutionsByNodeId: mockNodeExecutionsByNodeId,
      updateTask: mockUpdateTask,
      cancelWorkflowRun: mockCancelWorkflowRun,
      recoverWorkflowTask: mockRecoverWorkflowTask,
      submitForReview: mockSubmitForReview,
      ensureTaskAgentSession: mockEnsureTaskAgentSession,
      sendTaskMessage: mockSendTaskMessage,
      subscribeTaskActivity: mockSubscribeTaskActivity,
      unsubscribeTaskActivity: mockUnsubscribeTaskActivity,
      ensureConfigData: vi.fn().mockResolvedValue(undefined),
      ensureNodeExecutions: vi.fn().mockResolvedValue(undefined),
      workflowVersions: signal(new Map()),
      fetchWorkflowDetail: vi.fn((id: string) =>
        Promise.resolve(mockWorkflows.value.find((w) => w.id === id) ?? null)
      ),
    };
  },
}));

function makeWorkflowRun(overrides: Partial<SpaceWorkflowRun> = {}): SpaceWorkflowRun {
  return {
    id: 'run-1',
    spaceId: 'space-1',
    workflowId: 'workflow-1',
    title: 'Test Run',
    status: 'in_progress',
    startedAt: Date.now(),
    completedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

vi.mock('../SpaceTaskUnifiedThread', () => ({
  SpaceTaskUnifiedThread: ({
    taskId,
    topInsetClass,
    bottomInsetClass,
    bottomScrollPaddingClass,
    bottomInsetPx,
  }: {
    taskId: string;
    topInsetClass?: string;
    bottomInsetClass?: string;
    bottomScrollPaddingClass?: string;
    bottomInsetPx?: number;
  }) => (
    <div
      data-testid="space-task-unified-thread"
      data-task-id={taskId}
      data-top-inset={topInsetClass ?? ''}
      data-bottom-inset={bottomInsetClass ?? ''}
      data-bottom-scroll-padding={bottomScrollPaddingClass ?? ''}
      data-bottom-inset-px={bottomInsetPx ?? ''}
    />
  ),
}));

const { mockWorkflowCanvasOnNodeClick } = vi.hoisted(() => ({
  mockWorkflowCanvasOnNodeClick: vi.fn(),
}));

vi.mock('../ReadOnlyWorkflowCanvas', () => ({
  ReadOnlyWorkflowCanvas: ({
    workflowId,
    runId,
    spaceId,
    onNodeClick,
    class: className,
  }: {
    workflowId: string;
    runId?: string | null;
    spaceId: string;
    onNodeClick?: (nodeId: string, nodeName: string, agentNames: string[]) => void;
    class?: string;
  }) => {
    mockWorkflowCanvasOnNodeClick.mockImplementation(onNodeClick);
    return (
      <div
        data-testid="workflow-canvas"
        data-workflow-id={workflowId}
        data-run-id={runId}
        data-space-id={spaceId}
        class={className}
      />
    );
  },
}));

vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

mockTasks = signal<SpaceTask[]>([]);
mockAgents = signal<SpaceWorkerAgent[]>([]);
mockWorkflows = signal<SpaceWorkflow[]>([]);
mockWorkflowRuns = signal<SpaceWorkflowRun[]>([]);
mockTaskActivity = signal<Map<string, SpaceTaskActivityMember[]>>(new Map());
mockTaskMessageActivity = signal<Map<string, number>>(new Map());
mockNodeExecutions = signal<NodeExecution[]>([]);
mockNodeExecutionsByNodeId = signal<Map<string, unknown[]>>(new Map());

import { SpaceTaskPane } from '../SpaceTaskPane';
import { rightPanelTargetSignal } from '../../../lib/signals';

beforeEach(() => {
  mockTaskMessageActivity.value = new Map();
});

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    taskNumber: 1,
    title: 'Fix the bug',
    description: 'Task description',
    status: 'open',
    priority: 'normal',
    dependsOn: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function setupTaskWithActivity(taskOverrides: Partial<SpaceTask> = {}) {
  const task = makeTask({
    status: 'in_progress',
    workflowRunId: 'run-1',
    ...taskOverrides,
  });
  mockTasks.value = [task];
  mockWorkflows.value = [
    {
      id: 'workflow-1',
      spaceId: 'space-1',
      name: 'Test Workflow',
      nodes: [
        {
          id: 'node-1',
          name: 'Coding',
          agents: [{ name: 'coder', agentId: 'agent-coder' }],
        },
      ],
    } as SpaceWorkflow,
  ];
  mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
  mockNodeExecutions.value = [
    {
      id: 'exec-1',
      workflowRunId: 'run-1',
      workflowNodeId: 'node-1',
      agentName: 'coder',
      agentSessionId: 'session-coder-1',
      status: 'in_progress',
    } as NodeExecution,
  ];
  mockTaskActivity.value = new Map([
    [
      'task-1',
      [
        {
          id: 'member-1',
          sessionId: 'session-coder-1',
          kind: 'node_agent' as const,
          label: 'Coder',
          role: 'coder',
          state: 'active' as const,
          processingStatus: 'idle' as const,
          messageCount: 0,
        } as SpaceTaskActivityMember,
      ],
    ],
  ]);
  return task;
}

describe('SpaceTaskPane', () => {
  beforeEach(() => {
    cleanup();
    mockTasks.value = [];
    mockAgents.value = [];
    mockWorkflows.value = [];
    mockWorkflowRuns.value = [];
    mockTaskActivity.value = new Map();
    mockNodeExecutions.value = [];
    mockUpdateTask.mockClear();
    mockCancelWorkflowRun.mockClear();
    mockRecoverWorkflowTask.mockClear();
    mockEnsureTaskAgentSession.mockReset();
    mockEnsureTaskAgentSession.mockImplementation(async () =>
      makeTask({ status: 'in_progress', taskAgentSessionId: 'session-ensured' })
    );
    mockSendTaskMessage.mockClear();
    mockNavigateToSpaceAgent.mockClear();
    mockNavigateToSpaceTask.mockClear();
    mockSubscribeTaskActivity.mockClear();
    mockUnsubscribeTaskActivity.mockClear();
    mockSpaceOverlaySessionIdSignal.value = null;
    mockSpaceOverlayAgentNameSignal.value = null;
    mockSpaceOverlayTaskContextSignal.value = null;
    mockCurrentSpaceTaskViewTabSignal.value = 'thread';
    mockCurrentSpaceIdSignal.value = null;
    rightPanelTargetSignal.value = null;
    mockWorkflowCanvasOnNodeClick.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows empty state when taskId is null', () => {
    const { getByText } = render(<SpaceTaskPane taskId={null} />);
    expect(getByText('Select a task to view details')).toBeTruthy();
  });

  it('shows task not found when taskId is missing', () => {
    mockTasks.value = [makeTask()];
    const { getByText } = render(<SpaceTaskPane taskId="missing" />);
    expect(getByText('Task not found')).toBeTruthy();
  });

  it('renders title, status, and high priority badge', () => {
    mockTasks.value = [makeTask({ title: 'My Task', status: 'in_progress', priority: 'high' })];
    const { getByText, getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
    expect(getByText('My Task')).toBeTruthy();
    expect(getAllByText('In Progress').length).toBeGreaterThan(0);
    expect(getByText('High Priority')).toBeTruthy();
  });

  it('shows the task number in the header', () => {
    mockTasks.value = [makeTask({ title: 'Review launch checklist', taskNumber: 173 })];
    const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
    expect(getByText('Review launch checklist')).toBeTruthy();
    expect(getByText((_content, element) => element?.textContent === '#173')).toBeTruthy();
  });

  it('omits review status from the header when the approval action bar is active', () => {
    mockTasks.value = [
      makeTask({
        status: 'review',
        pendingCheckpointType: 'task_completion',
        taskAgentSessionId: 'session-abc',
      }),
    ];
    const { getByTestId, getByText, queryByTestId } = render(<SpaceTaskPane taskId="task-1" />);
    expect(queryByTestId('task-status-label')).toBeNull();
    expect(getByText('Normal Priority')).toBeTruthy();
    expect(getByTestId('pending-task-completion-banner')).toBeTruthy();
  });

  it('renders unified task thread component when workflow run exists', () => {
    setupTaskWithActivity();
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" />);
    expect(getByTestId('task-thread-panel')).toBeTruthy();
    expect(getByTestId('space-task-unified-thread')).toBeTruthy();
  });

  it('redirects log view to thread when task has no workflow run', async () => {
    mockCurrentSpaceTaskViewTabSignal.value = 'log';
    mockTasks.value = [makeTask({ workflowRunId: null })];

    render(<SpaceTaskPane taskId="task-1" />);

    await waitFor(() => {
      expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('space-1', 'task-1', 'thread', true);
    });
    expect(mockCurrentSpaceTaskViewTabSignal.value).toBe('thread');
  });

  it('shows the task information view instead of placeholder copy when the task has no message activity', () => {
    mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: null })];
    mockTaskMessageActivity.value = new Map([['task-1', 0]]);
    const { getByTestId, getByText, queryByText } = render(<SpaceTaskPane taskId="task-1" />);
    expect(getByTestId('task-info-view')).toBeTruthy();
    expect(queryByText(/Task thread is not available/)).toBeNull();
    expect(getByText('Task description')).toBeTruthy();
    expect(getByText('This task has no agent activity yet.')).toBeTruthy();
  });

  it('keeps the thread view while message activity is still unknown', () => {
    mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: null })];
    const { getByTestId, queryByTestId } = render(<SpaceTaskPane taskId="task-1" />);
    expect(getByTestId('space-task-unified-thread')).toBeTruthy();
    expect(queryByTestId('task-info-view')).toBeNull();
  });

  it('calls onClose when back button is clicked', () => {
    mockTasks.value = [makeTask()];
    const onClose = vi.fn();
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" onClose={onClose} />);
    fireEvent.click(getByTestId('task-back-button'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SpaceTaskPane — composer', () => {
  beforeEach(() => {
    cleanup();
    mockTasks.value = [];
    mockSendTaskMessage.mockClear();
    mockEnsureTaskAgentSession.mockReset();
    mockEnsureTaskAgentSession.mockImplementation(async () =>
      makeTask({ status: 'in_progress', taskAgentSessionId: 'session-ensured' })
    );
  });

  afterEach(() => {
    cleanup();
  });

  it.skip('sends a message when a task has node agent activity', async () => {
    setupTaskWithActivity();
    const { getByPlaceholderText, getByTestId } = render(<SpaceTaskPane taskId="task-1" />);

    fireEvent.input(getByPlaceholderText('Message coder...'), {
      target: { value: 'Looks good to me' },
    });
    fireEvent.click(getByTestId('send-button'));

    await waitFor(() =>
      expect(mockSendTaskMessage).toHaveBeenCalledWith(
        'task-1',
        'Looks good to me',
        {
          kind: 'node_agent',
        },
        undefined,
        'immediate'
      )
    );
    expect(mockEnsureTaskAgentSession).not.toHaveBeenCalled();
  });

  it.skip('shows send error text when sending fails', async () => {
    mockSendTaskMessage.mockRejectedValueOnce(new Error('Invalid transition'));
    setupTaskWithActivity();
    const { getByPlaceholderText, getByText, getByTestId } = render(
      <SpaceTaskPane taskId="task-1" />
    );

    fireEvent.input(getByPlaceholderText('Message coder...'), {
      target: { value: 'Approved' },
    });
    fireEvent.click(getByTestId('send-button'));

    await waitFor(() => expect(getByText('Invalid transition')).toBeTruthy());
    const thread = getByTestId('space-task-unified-thread');
    expect(Number(thread.getAttribute('data-bottom-inset-px'))).toBeGreaterThanOrEqual(144);
  });

  it('does not submit empty message', () => {
    setupTaskWithActivity();
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('send-button'));
    expect(mockSendTaskMessage).not.toHaveBeenCalled();
  });

  it('hides the composer for stopped tasks while live tasks keep it', () => {
    setupTaskWithActivity({ status: 'stopped' });
    const stopped = render(<SpaceTaskPane taskId="task-1" />);
    expect(stopped.queryByTestId('task-session-chat-composer')).toBeNull();
    expect(stopped.getByTestId('task-stopped-footer')).toBeTruthy();
    stopped.unmount();

    setupTaskWithActivity({ status: 'in_progress' });
    const live = render(<SpaceTaskPane taskId="task-1" />);
    expect(live.getByTestId('task-session-chat-composer')).toBeTruthy();
    expect(live.queryByTestId('task-stopped-footer')).toBeNull();
  });

  it('surfaces transition errors outside the composer for stopped tasks', async () => {
    mockTasks.value = [
      makeTask({
        status: 'stopped',
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-abc',
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', status: 'blocked' })];
    mockRecoverWorkflowTask.mockRejectedValueOnce(new Error('Run cannot be recovered'));
    const { getByTestId, getByText, findByTestId } = render(<SpaceTaskPane taskId="task-1" />);

    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Resume workflow'));

    const error = await findByTestId('task-pane-transition-error');
    expect(error.textContent).toContain('Run cannot be recovered');
    expect(error.getAttribute('role')).toBe('alert');
  });

  it.skip('disables textarea while send is in flight and re-enables after completion', async () => {
    let resolveSend: () => void;
    const sendPromise = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    mockSendTaskMessage.mockReturnValueOnce(sendPromise);
    setupTaskWithActivity();
    const { getByPlaceholderText, getByTestId } = render(<SpaceTaskPane taskId="task-1" />);

    const textarea = getByPlaceholderText('Message coder...') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'Work in progress check' } });
    fireEvent.click(getByTestId('send-button'));

    await waitFor(() => expect(textarea.disabled).toBe(true));

    resolveSend!();
    await waitFor(() => expect(textarea.disabled).toBe(false));
  });

  it.skip('clears draft after successful send', async () => {
    setupTaskWithActivity();
    const { getByPlaceholderText } = render(<SpaceTaskPane taskId="task-1" />);

    const textarea = getByPlaceholderText('Message coder...') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'Approve the PR' } });
    expect(textarea.value).toBe('Approve the PR');

    fireEvent.submit(textarea.form!);

    await waitFor(() =>
      expect(mockSendTaskMessage).toHaveBeenCalledWith(
        'task-1',
        'Approve the PR',
        {
          kind: 'node_agent',
        },
        undefined,
        'immediate'
      )
    );
    await waitFor(() => expect(textarea.value).toBe(''));
  });

  it.skip('submits message on Enter key (without Shift)', async () => {
    setupTaskWithActivity();
    const { getByPlaceholderText } = render(<SpaceTaskPane taskId="task-1" />);

    const textarea = getByPlaceholderText('Message coder...');
    fireEvent.input(textarea, { target: { value: 'Quick approve' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() =>
      expect(mockSendTaskMessage).toHaveBeenCalledWith(
        'task-1',
        'Quick approve',
        {
          kind: 'node_agent',
        },
        undefined,
        'immediate'
      )
    );
  });

  it.skip('does not submit on Shift+Enter (newline insertion)', () => {
    setupTaskWithActivity();
    const { getByPlaceholderText } = render(<SpaceTaskPane taskId="task-1" />);

    const textarea = getByPlaceholderText('Message coder...');
    fireEvent.input(textarea, { target: { value: 'line one' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(mockSendTaskMessage).not.toHaveBeenCalled();
  });

  it('disables composer send when task has no activity or workflow', () => {
    mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: null })];
    const { queryByPlaceholderText, queryByTestId } = render(<SpaceTaskPane taskId="task-1" />);

    expect(queryByPlaceholderText('Select a target agent...')).toBeNull();
    const sendButton = queryByTestId('send-button');
    if (sendButton) {
      expect(sendButton.getAttribute('disabled')).not.toBeNull();
    }
  });

  it.skip('clears threadSendError when a new send succeeds', async () => {
    mockSendTaskMessage.mockRejectedValueOnce(new Error('Temporary error'));
    setupTaskWithActivity();
    const { getByPlaceholderText, getByText, queryByText, getByTestId } = render(
      <SpaceTaskPane taskId="task-1" />
    );

    const textarea = getByPlaceholderText('Message coder...');

    fireEvent.input(textarea, { target: { value: 'First try' } });
    fireEvent.click(getByTestId('send-button'));
    await waitFor(() => expect(getByText('Temporary error')).toBeTruthy());

    mockSendTaskMessage.mockResolvedValueOnce(undefined);
    fireEvent.input(textarea, { target: { value: 'Second try' } });
    fireEvent.click(getByTestId('send-button'));
    await waitFor(() => expect(queryByText('Temporary error')).toBeNull());
  });
});

describe('SpaceTaskPane — canvas toggle', () => {
  beforeEach(() => {
    cleanup();
    mockTasks.value = [];
    mockWorkflowRuns.value = [];
    mockWorkflows.value = [];
    mockNodeExecutionsByNodeId.value = new Map();
    mockTaskActivity.value = new Map();
    mockNodeExecutions.value = [];
    mockEnsureTaskAgentSession.mockReset();
    mockEnsureTaskAgentSession.mockImplementation(async () =>
      makeTask({ status: 'in_progress', taskAgentSessionId: 'session-ensured' })
    );
    mockWorkflowCanvasOnNodeClick.mockClear();
    mockNavigateToSpaceTask.mockClear();
    mockPushOverlayHistory.mockClear();
    mockPushOverlayHistoryForPendingAgent.mockClear();
    mockSpaceOverlaySessionIdSignal.value = null;
    mockSpaceOverlayAgentNameSignal.value = null;
    mockSpaceOverlayTaskContextSignal.value = null;
    mockCurrentSpaceTaskViewTabSignal.value = 'thread';
    mockCurrentSpaceIdSignal.value = null;
    rightPanelTargetSignal.value = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('does not show canvas toggle for tasks without workflowRunId', () => {
    mockTasks.value = [makeTask({ workflowRunId: null })];
    const { queryByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
    expect(queryByTestId('canvas-toggle')).toBeNull();
  });

  it('does not show canvas toggle for workflow tasks without a matching run in the store', () => {
    mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
    mockWorkflowRuns.value = [];
    const { queryByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
    expect(queryByTestId('canvas-toggle')).toBeNull();
  });

  it('shows canvas toggle for tasks with workflowRunId and a matching run', () => {
    mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
    expect(getByTestId('canvas-toggle')).toBeTruthy();
  });

  it('clicking canvas toggle switches to canvas view', () => {
    mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    const { getByTestId, queryByTestId } = render(
      <SpaceTaskPane taskId="task-1" spaceId="space-1" />
    );
    expect(queryByTestId('canvas-view')).toBeNull();
    expect(queryByTestId('task-thread-panel')).toBeTruthy();

    fireEvent.click(getByTestId('canvas-toggle'));

    expect(getByTestId('canvas-view')).toBeTruthy();
    expect(getByTestId('workflow-canvas')).toBeTruthy();
    expect(queryByTestId('task-thread-panel')).toBeNull();
  });

  it('clicking canvas toggle again switches back to thread view', () => {
    mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    const { getByTestId, queryByTestId } = render(
      <SpaceTaskPane taskId="task-1" spaceId="space-1" />
    );

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(getByTestId('canvas-view')).toBeTruthy();

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(queryByTestId('canvas-view')).toBeNull();
    expect(getByTestId('task-thread-panel')).toBeTruthy();
  });

  it('canvas view renders WorkflowCanvas with correct run and workflow IDs', () => {
    mockTasks.value = [makeTask({ workflowRunId: 'run-1', spaceId: 'space-1' })];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'wf-abc' })];
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

    fireEvent.click(getByTestId('canvas-toggle'));

    const canvas = getByTestId('workflow-canvas');
    expect(canvas.getAttribute('data-workflow-id')).toBe('wf-abc');
    expect(canvas.getAttribute('data-run-id')).toBe('run-1');
  });

  it('routes legacy artifacts view into the right panel and returns to thread', async () => {
    mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    mockCurrentSpaceTaskViewTabSignal.value = 'artifacts';
    const { queryByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

    expect(queryByTestId('canvas-view')).toBeNull();
    expect(queryByTestId('task-thread-panel')).toBeTruthy();
    await waitFor(() =>
      expect(rightPanelTargetSignal.value).toEqual({
        type: 'task',
        spaceId: 'space-1',
        taskId: 'task-1',
        tab: 'artifacts',
      })
    );
    expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('space-1', 'task-1', 'thread', true);
  });

  it('keeps canonical right-panel task targets while preserving slug navigation', async () => {
    mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    mockCurrentSpaceTaskViewTabSignal.value = 'artifacts';
    render(<SpaceTaskPane taskId="task-1" spaceId="space-1" navigationSpaceId="space-slug" />);

    await waitFor(() =>
      expect(rightPanelTargetSignal.value).toEqual({
        type: 'task',
        spaceId: 'space-1',
        taskId: 'task-1',
        tab: 'artifacts',
      })
    );
    expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('space-slug', 'task-1', 'thread', true);
  });

  it('canvas toggle aria-pressed reflects current state', () => {
    mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

    const btn = getByTestId('canvas-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(btn);
    expect(getByTestId('canvas-toggle').getAttribute('aria-pressed')).toBe('true');
  });

  it('canvas node click on an unstarted node opens its own pending overlay, never the task-agent session', () => {
    mockTasks.value = [
      makeTask({
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-task',
        activeSession: null,
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    mockNodeExecutionsByNodeId.value = new Map();
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(getByTestId('workflow-canvas')).toBeTruthy();

    mockWorkflowCanvasOnNodeClick('node-1', 'Coder Node', ['coder']);

    expect(mockSpaceOverlaySessionIdSignal.value).toBe(null);
    expect(mockPushOverlayHistoryForPendingAgent).toHaveBeenCalledWith('task-1', 'coder', 'node-1');
  });

  it('canvas node click opens overlay with the node-specific agent session (primary path)', () => {
    mockTasks.value = [
      makeTask({
        id: 'task-1',
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-task',
        activeSession: null,
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    mockAgents.value = [
      {
        id: 'agent-1',
        spaceId: 'space-1',
        name: 'Coder Node',
        instructions: null,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ];
    mockWorkflows.value = [
      {
        id: 'workflow-1',
        spaceId: 'space-1',
        name: 'Wf',
        description: '',
        nodes: [
          { id: 'node-1', name: 'Coder Node', agents: [{ agentId: 'agent-1', name: 'coder' }] },
        ],
        startNodeId: 'node-1',
        channels: [],
        gates: [],
        tags: [],
        createdAt: 1000,
        updatedAt: 1000,
      },
    ];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          {
            id: 'session-node-agent',
            sessionId: 'session-node-agent',
            kind: 'node_agent' as const,
            label: 'Coder Node',
            role: 'coder',
            state: 'active' as const,
            messageCount: 0,
            nodeExecution: {
              nodeExecutionId: 'exec-coder-1',
              nodeId: 'node-1',
              agentName: 'coder',
              status: 'in_progress' as const,
            },
          },
        ],
      ],
    ]);
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(getByTestId('workflow-canvas')).toBeTruthy();

    mockWorkflowCanvasOnNodeClick('node-1', 'Coder Node', ['coder']);

    expect(mockSpaceOverlaySessionIdSignal.value).toBe('session-node-agent');
    expect(mockSpaceOverlayAgentNameSignal.value).toBe('Coder Node');
    expect(mockSpaceOverlayTaskContextSignal.value).toEqual({
      taskId: 'task-1',
      agentName: 'coder',
      nodeExecutionId: 'exec-coder-1',
      workflowNodeId: 'node-1',
      sessionId: 'session-node-agent',
    });
  });

  describe('identity-safe node clicks', () => {
    function setupMultiNodeWorkflow(
      nodes: Array<{
        id: string;
        name: string;
        agents: Array<{ name: string; agentId: string }>;
        postApproval?: { targetAgent: string };
      }>,
      taskOverrides: Partial<SpaceTask> = {}
    ) {
      mockTasks.value = [
        makeTask({
          id: 'task-1',
          workflowRunId: 'run-1',
          taskAgentSessionId: 'session-task',
          activeSession: null,
          ...taskOverrides,
        }),
      ];
      mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
      mockWorkflows.value = [
        {
          id: 'workflow-1',
          spaceId: 'space-1',
          name: 'Multi',
          nodes: nodes.map((n) => ({
            id: n.id,
            name: n.name,
            agents: n.agents,
            ...(n.postApproval ? { postApproval: n.postApproval } : {}),
          })),
          startNodeId: nodes[0]?.id,
        } as SpaceWorkflow,
      ];
    }

    function activityFor(nodeId: string, agentName: string, sessionId: string, label?: string) {
      return {
        id: sessionId,
        sessionId,
        kind: 'node_agent' as const,
        label: label ?? agentName,
        role: agentName,
        state: 'active' as const,
        messageCount: 0,
        nodeExecution: {
          nodeExecutionId: `exec-${sessionId}`,
          nodeId,
          agentName,
          status: 'in_progress' as const,
        },
      } as SpaceTaskActivityMember;
    }

    it('clicking an unstarted downstream node never opens the active node session', () => {
      setupMultiNodeWorkflow([
        { id: 'node-1', name: 'Coding', agents: [{ name: 'coder', agentId: 'a-coder' }] },
        { id: 'node-2', name: 'Review', agents: [{ name: 'reviewer', agentId: 'a-reviewer' }] },
      ]);
      mockNodeExecutions.value = [
        {
          id: 'exec-coder',
          workflowRunId: 'run-1',
          workflowNodeId: 'node-1',
          agentName: 'coder',
          agentId: 'a-coder',
          agentSessionId: 'session-coder',
          status: 'in_progress',
        } as NodeExecution,
      ];
      mockTaskActivity.value = new Map([
        ['task-1', [activityFor('node-1', 'coder', 'session-coder')]],
      ]);
      const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
      fireEvent.click(getByTestId('canvas-toggle'));

      mockWorkflowCanvasOnNodeClick('node-2', 'Review', ['reviewer']);

      expect(mockSpaceOverlaySessionIdSignal.value).toBe(null);
      expect(mockPushOverlayHistory).not.toHaveBeenCalled();
      expect(mockPushOverlayHistoryForPendingAgent).toHaveBeenCalledWith(
        'task-1',
        'reviewer',
        'node-2'
      );
    });

    it('two nodes reusing the same slot name are disambiguated by node ID', () => {
      setupMultiNodeWorkflow([
        { id: 'node-1', name: 'First Review', agents: [{ name: 'reviewer', agentId: 'a-r' }] },
        { id: 'node-2', name: 'Second Review', agents: [{ name: 'reviewer', agentId: 'a-r' }] },
      ]);
      mockNodeExecutions.value = [
        {
          id: 'exec-r1',
          workflowRunId: 'run-1',
          workflowNodeId: 'node-1',
          agentName: 'reviewer',
          agentId: 'a-r',
          agentSessionId: 'session-reviewer-1',
          status: 'in_progress',
        } as NodeExecution,
        {
          id: 'exec-r2',
          workflowRunId: 'run-1',
          workflowNodeId: 'node-2',
          agentName: 'reviewer',
          agentId: 'a-r',
          agentSessionId: 'session-reviewer-2',
          status: 'in_progress',
        } as NodeExecution,
      ];
      const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
      fireEvent.click(getByTestId('canvas-toggle'));

      mockWorkflowCanvasOnNodeClick('node-2', 'Second Review', ['reviewer']);
      expect(mockSpaceOverlaySessionIdSignal.value).toBe('session-reviewer-2');

      mockSpaceOverlaySessionIdSignal.value = null;
      mockPushOverlayHistory.mockClear();
      mockWorkflowCanvasOnNodeClick('node-1', 'First Review', ['reviewer']);
      expect(mockSpaceOverlaySessionIdSignal.value).toBe('session-reviewer-1');
    });

    it('spawned post-approval merger node opens its own session once identity is available', async () => {
      setupMultiNodeWorkflow([
        { id: 'node-1', name: 'Coding', agents: [{ name: 'coder', agentId: 'a-coder' }] },
        {
          id: 'node-merger',
          name: 'Post-Approval',
          agents: [{ name: 'merger', agentId: 'a-merger' }],
          postApproval: { targetAgent: 'merger' },
        },
      ]);
      mockTasks.value = [
        makeTask({
          id: 'task-1',
          workflowRunId: 'run-1',
          postApprovalSessionId: 'session-merger',
        }),
      ];
      const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
      fireEvent.click(getByTestId('canvas-toggle'));

      await waitFor(() => {
        mockWorkflowCanvasOnNodeClick('node-merger', 'Post-Approval', ['merger']);
        expect(mockSpaceOverlaySessionIdSignal.value).toBe('session-merger');
      });
      expect(mockPushOverlayHistory).toHaveBeenCalledWith(
        'session-merger',
        expect.any(String),
        undefined,
        {
          taskId: 'task-1',
          agentName: 'merger',
          workflowNodeId: 'node-merger',
          sessionId: 'session-merger',
        }
      );
    });

    it('pre-spawn merger node activates its own slot (no fallback to another node)', () => {
      setupMultiNodeWorkflow([
        { id: 'node-1', name: 'Coding', agents: [{ name: 'coder', agentId: 'a-coder' }] },
        {
          id: 'node-merger',
          name: 'Post-Approval',
          agents: [{ name: 'merger', agentId: 'a-merger' }],
          postApproval: { targetAgent: 'merger' },
        },
      ]);
      mockNodeExecutions.value = [
        {
          id: 'exec-coder',
          workflowRunId: 'run-1',
          workflowNodeId: 'node-1',
          agentName: 'coder',
          agentId: 'a-coder',
          agentSessionId: 'session-coder',
          status: 'in_progress',
        } as NodeExecution,
      ];
      const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
      fireEvent.click(getByTestId('canvas-toggle'));

      mockWorkflowCanvasOnNodeClick('node-merger', 'Post-Approval', ['merger']);
      expect(mockSpaceOverlaySessionIdSignal.value).toBe(null);
      expect(mockPushOverlayHistoryForPendingAgent).toHaveBeenCalledWith(
        'task-1',
        'merger',
        'node-merger'
      );
    });

    it('zero-agent node presents an empty state and never falls back', async () => {
      setupMultiNodeWorkflow([
        { id: 'node-1', name: 'Coding', agents: [{ name: 'coder', agentId: 'a-coder' }] },
        { id: 'node-sink', name: 'Sink', agents: [] },
      ]);
      mockNodeExecutions.value = [
        {
          id: 'exec-coder',
          workflowRunId: 'run-1',
          workflowNodeId: 'node-1',
          agentName: 'coder',
          agentId: 'a-coder',
          agentSessionId: 'session-coder',
          status: 'in_progress',
        } as NodeExecution,
      ];
      const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
      fireEvent.click(getByTestId('canvas-toggle'));

      mockWorkflowCanvasOnNodeClick('node-sink', 'Sink', []);
      expect(mockSpaceOverlaySessionIdSignal.value).toBe(null);
      await waitFor(() => expect(getByTestId('node-agent-empty-state')).toBeTruthy());
    });

    it('multi-agent node with several live sessions presents a choice (no arbitrary selection)', async () => {
      setupMultiNodeWorkflow([
        {
          id: 'node-plan-review',
          name: 'Plan Review',
          agents: [
            { name: 'architecture-reviewer', agentId: 'a-arch' },
            { name: 'security-reviewer', agentId: 'a-sec' },
          ],
        },
      ]);
      mockNodeExecutions.value = [
        {
          id: 'exec-arch',
          workflowRunId: 'run-1',
          workflowNodeId: 'node-plan-review',
          agentName: 'architecture-reviewer',
          agentId: 'a-arch',
          agentSessionId: 'session-arch',
          status: 'in_progress',
        } as NodeExecution,
        {
          id: 'exec-sec',
          workflowRunId: 'run-1',
          workflowNodeId: 'node-plan-review',
          agentName: 'security-reviewer',
          agentId: 'a-sec',
          agentSessionId: 'session-sec',
          status: 'in_progress',
        } as NodeExecution,
      ];
      const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
      fireEvent.click(getByTestId('canvas-toggle'));

      mockWorkflowCanvasOnNodeClick('node-plan-review', 'Plan Review', [
        'architecture-reviewer',
        'security-reviewer',
      ]);
      expect(mockSpaceOverlaySessionIdSignal.value).toBe(null);
      await waitFor(() => expect(getByTestId('node-agent-choice-overlay')).toBeTruthy());
      expect(getByTestId('node-agent-choice-live-architecture-reviewer')).toBeTruthy();
      expect(getByTestId('node-agent-choice-live-security-reviewer')).toBeTruthy();

      fireEvent.click(getByTestId('node-agent-choice-live-security-reviewer'));
      await waitFor(() => expect(mockSpaceOverlaySessionIdSignal.value).toBe('session-sec'));
    });

    it('rejects a chooser choice whose execution transitioned to pending (spawn-retry dead session)', async () => {
      setupMultiNodeWorkflow([
        {
          id: 'node-plan-review',
          name: 'Plan Review',
          agents: [
            { name: 'architecture-reviewer', agentId: 'a-arch' },
            { name: 'security-reviewer', agentId: 'a-sec' },
          ],
        },
      ]);
      mockNodeExecutions.value = [
        {
          id: 'exec-arch',
          workflowRunId: 'run-1',
          workflowNodeId: 'node-plan-review',
          agentName: 'architecture-reviewer',
          agentId: 'a-arch',
          agentSessionId: 'session-arch',
          status: 'in_progress',
        } as NodeExecution,
        {
          id: 'exec-sec',
          workflowRunId: 'run-1',
          workflowNodeId: 'node-plan-review',
          agentName: 'security-reviewer',
          agentId: 'a-sec',
          agentSessionId: 'session-sec',
          status: 'in_progress',
        } as NodeExecution,
      ];
      const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
      fireEvent.click(getByTestId('canvas-toggle'));
      mockWorkflowCanvasOnNodeClick('node-plan-review', 'Plan Review', [
        'architecture-reviewer',
        'security-reviewer',
      ]);
      await waitFor(() => expect(getByTestId('node-agent-choice-overlay')).toBeTruthy());

      mockNodeExecutions.value = mockNodeExecutions.value.map((e) =>
        e.id === 'exec-sec' ? ({ ...e, status: 'pending' } as NodeExecution) : e
      );
      await waitFor(() => {});
      fireEvent.click(getByTestId('node-agent-choice-live-security-reviewer'));
      expect(mockSpaceOverlaySessionIdSignal.value).toBeNull();
      expect(mockPushOverlayHistory).not.toHaveBeenCalled();
    });

    it('multi-agent node with mixed live + unstarted slots shows a choice (not just the live one)', () => {
      setupMultiNodeWorkflow([
        {
          id: 'node-plan-review',
          name: 'Plan Review',
          agents: [
            { name: 'architecture-reviewer', agentId: 'a-arch' },
            { name: 'security-reviewer', agentId: 'a-sec' },
          ],
        },
      ]);
      mockNodeExecutions.value = [
        {
          id: 'exec-arch',
          workflowRunId: 'run-1',
          workflowNodeId: 'node-plan-review',
          agentName: 'architecture-reviewer',
          agentId: 'a-arch',
          agentSessionId: 'session-arch',
          status: 'in_progress',
        } as NodeExecution,
      ];
      const { getByTestId, queryByTestId } = render(
        <SpaceTaskPane taskId="task-1" spaceId="space-1" />
      );
      fireEvent.click(getByTestId('canvas-toggle'));

      mockWorkflowCanvasOnNodeClick('node-plan-review', 'Plan Review', [
        'architecture-reviewer',
        'security-reviewer',
      ]);
      expect(mockSpaceOverlaySessionIdSignal.value).toBeNull();
      expect(mockPushOverlayHistory).not.toHaveBeenCalled();
    });

    it('two unstarted nodes sharing a slot name carry distinct node IDs into activation', async () => {
      setupMultiNodeWorkflow([
        { id: 'node-1', name: 'First Review', agents: [{ name: 'reviewer', agentId: 'a-r' }] },
        { id: 'node-2', name: 'Second Review', agents: [{ name: 'reviewer', agentId: 'a-r' }] },
      ]);
      const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
      fireEvent.click(getByTestId('canvas-toggle'));

      await waitFor(() => {
        mockWorkflowCanvasOnNodeClick('node-2', 'Second Review', ['reviewer']);
        expect(mockPushOverlayHistoryForPendingAgent).toHaveBeenCalledWith(
          'task-1',
          'reviewer',
          'node-2'
        );
      });
    });

    it('honors legacy workflow-level postApproval route (no node-level route)', async () => {
      mockTasks.value = [
        makeTask({
          id: 'task-1',
          workflowRunId: 'run-1',
          postApprovalSessionId: 'session-merger',
        }),
      ];
      mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
      mockWorkflows.value = [
        {
          id: 'workflow-1',
          spaceId: 'space-1',
          name: 'Legacy',
          nodes: [
            { id: 'node-coder', name: 'Coding', agents: [{ name: 'coder', agentId: 'a-c' }] },
            {
              id: 'node-merger',
              name: 'Post-Approval',
              agents: [{ name: 'merger', agentId: 'a-m' }],
            },
          ],
          postApproval: { targetAgent: 'merger', instructions: 'merge' },
          startNodeId: 'node-coder',
        } as SpaceWorkflow,
      ];
      const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
      fireEvent.click(getByTestId('canvas-toggle'));

      await waitFor(() => {
        mockWorkflowCanvasOnNodeClick('node-merger', 'Post-Approval', ['merger']);
        expect(mockSpaceOverlaySessionIdSignal.value).toBe('session-merger');
      });
    });
  });

  describe('edit task menu item', () => {
    it('shows edit item in dropdown for in_progress tasks', () => {
      mockTasks.value = [makeTask({ status: 'in_progress' })];
      const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
      fireEvent.click(getByTestId('task-actions-menu-trigger'));
      expect(getByText('Edit title, description, or priority')).toBeTruthy();
    });

    it('shows edit item in dropdown for open tasks', () => {
      mockTasks.value = [makeTask({ status: 'open' })];
      const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
      fireEvent.click(getByTestId('task-actions-menu-trigger'));
      expect(getByText('Edit title, description, or priority')).toBeTruthy();
    });

    it('shows edit item in dropdown for draft tasks', () => {
      mockTasks.value = [makeTask({ status: 'draft' })];
      const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
      fireEvent.click(getByTestId('task-actions-menu-trigger'));
      expect(getByText('Edit title, description, or priority')).toBeTruthy();
    });

    it('shows edit item in dropdown for blocked tasks', () => {
      mockTasks.value = [makeTask({ status: 'blocked' })];
      const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
      fireEvent.click(getByTestId('task-actions-menu-trigger'));
      expect(getByText('Edit title, description, or priority')).toBeTruthy();
    });

    it('shows edit item in dropdown for review tasks', () => {
      mockTasks.value = [makeTask({ status: 'review', taskAgentSessionId: 'session-abc' })];
      const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
      fireEvent.click(getByTestId('task-actions-menu-trigger'));
      expect(getByText('Edit title, description, or priority')).toBeTruthy();
    });

    it('shows edit item in dropdown for approved tasks', () => {
      mockTasks.value = [makeTask({ status: 'approved', taskAgentSessionId: 'session-abc' })];
      const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
      fireEvent.click(getByTestId('task-actions-menu-trigger'));
      expect(getByText('Edit title, description, or priority')).toBeTruthy();
    });

    it('edit item is absent for terminal tasks (done)', () => {
      mockTasks.value = [makeTask({ status: 'done' })];
      const { queryByText } = render(<SpaceTaskPane taskId="task-1" />);
      expect(queryByText('Edit title, description, or priority')).toBeNull();
    });

    it('edit item is absent for terminal tasks (cancelled)', () => {
      mockTasks.value = [makeTask({ status: 'cancelled' })];
      const { queryByText } = render(<SpaceTaskPane taskId="task-1" />);
      expect(queryByText('Edit title, description, or priority')).toBeNull();
    });

    it('edit item is absent for terminal tasks (archived)', () => {
      mockTasks.value = [makeTask({ status: 'archived' })];
      const { queryByText } = render(<SpaceTaskPane taskId="task-1" />);
      expect(queryByText('Edit title, description, or priority')).toBeNull();
    });

    it('opens the edit modal when clicked', () => {
      mockTasks.value = [makeTask({ status: 'in_progress' })];
      const { getByTestId, getByText, queryByTestId } = render(<SpaceTaskPane taskId="task-1" />);
      expect(queryByTestId('edit-task-modal-content')).toBeNull();
      fireEvent.click(getByTestId('task-actions-menu-trigger'));
      fireEvent.click(getByText('Edit title, description, or priority'));
      expect(getByTestId('edit-task-modal-content')).toBeTruthy();
    });

    it('calls spaceStore.updateTask when edit is confirmed', async () => {
      mockTasks.value = [makeTask({ status: 'in_progress', title: 'Old Title' })];
      mockUpdateTask.mockResolvedValueOnce(makeTask({ status: 'in_progress', title: 'New Title' }));
      const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
      fireEvent.click(getByTestId('task-actions-menu-trigger'));
      fireEvent.click(getByText('Edit title, description, or priority'));

      fireEvent.input(getByTestId('edit-task-title'), {
        target: { value: 'New Title' },
      });
      fireEvent.click(getByTestId('edit-task-confirm'));

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith('task-1', {
          title: 'New Title',
        });
      });
    });

    it('shows inline error when updateTask fails', async () => {
      mockTasks.value = [makeTask({ status: 'in_progress', title: 'Old Title' })];
      mockUpdateTask.mockRejectedValueOnce(new Error('Server error'));

      const { getByTestId, getByText, findByTestId } = render(<SpaceTaskPane taskId="task-1" />);
      fireEvent.click(getByTestId('task-actions-menu-trigger'));
      fireEvent.click(getByText('Edit title, description, or priority'));

      fireEvent.input(getByTestId('edit-task-title'), {
        target: { value: 'New Title' },
      });
      fireEvent.click(getByTestId('edit-task-confirm'));

      const errEl = await findByTestId('edit-task-error');
      expect(errEl.textContent).toContain('Server error');
    });

    it('closes edit modal when task becomes terminal', async () => {
      mockTasks.value = [makeTask({ status: 'in_progress' })];
      const { getByTestId, getByText, queryByTestId } = render(<SpaceTaskPane taskId="task-1" />);
      fireEvent.click(getByTestId('task-actions-menu-trigger'));
      fireEvent.click(getByText('Edit title, description, or priority'));
      expect(getByTestId('edit-task-modal-content')).toBeTruthy();

      mockTasks.value = [makeTask({ status: 'done' })];

      await waitFor(() => {
        expect(queryByTestId('edit-task-modal-content')).toBeNull();
      });
    });

    it('clears edit modal state on task switch', () => {
      mockTasks.value = [
        makeTask({ id: 'task-1', status: 'in_progress' }),
        makeTask({ id: 'task-2', status: 'in_progress', taskNumber: 2 }),
      ];
      const { getByTestId, getByText, queryByTestId, rerender } = render(
        <SpaceTaskPane taskId="task-1" />
      );
      fireEvent.click(getByTestId('task-actions-menu-trigger'));
      fireEvent.click(getByText('Edit title, description, or priority'));
      expect(getByTestId('edit-task-modal-content')).toBeTruthy();

      rerender(<SpaceTaskPane taskId="task-2" />);

      expect(queryByTestId('edit-task-modal-content')).toBeNull();
    });
  });
  it('canvas node click matches by node ID + slot, not by label — regression for Review node bug', () => {
    mockTasks.value = [
      makeTask({
        id: 'task-1',
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-task',
        activeSession: null,
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    mockAgents.value = [];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          {
            id: 'session-reviewer',
            sessionId: 'session-reviewer',
            kind: 'node_agent' as const,
            label: 'Code Reviewer',
            role: 'reviewer',
            state: 'active' as const,
            messageCount: 2,
            nodeExecution: {
              nodeExecutionId: 'exec-reviewer',
              nodeId: 'node-review',
              agentName: 'reviewer',
              status: 'in_progress' as const,
            },
          },
        ],
      ],
    ]);
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(getByTestId('workflow-canvas')).toBeTruthy();

    mockWorkflowCanvasOnNodeClick('node-review', 'Review', ['reviewer']);

    expect(mockSpaceOverlaySessionIdSignal.value).toBe('session-reviewer');
    expect(mockSpaceOverlayAgentNameSignal.value).toBe('Code Reviewer');
  });

  it('main view control only exposes the canvas toggle', () => {
    mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    const { getByTestId, queryByTestId } = render(
      <SpaceTaskPane taskId="task-1" spaceId="space-1" />
    );

    expect(queryByTestId('thread-toggle')).toBeNull();
    expect(getByTestId('canvas-toggle')).toBeTruthy();
    expect(queryByTestId('artifacts-toggle')).toBeNull();
    expect(queryByTestId('timeline-toggle')).toBeNull();
    expect(queryByTestId('execution-log-toggle')).toBeNull();

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(getByTestId('canvas-view')).toBeTruthy();
    expect(queryByTestId('task-thread-panel')).toBeNull();
  });
});

describe('SpaceTaskPane — blocked reason banner', () => {
  beforeEach(() => {
    cleanup();
    mockTasks.value = [];
    mockEnsureTaskAgentSession.mockReset();
    mockEnsureTaskAgentSession.mockImplementation(async () =>
      makeTask({ status: 'blocked', taskAgentSessionId: 'session-ensured' })
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('shows blocked reason banner when task is blocked with result', () => {
    mockTasks.value = [
      makeTask({
        status: 'blocked',
        result: 'Waiting for API key configuration',
        taskAgentSessionId: 'session-abc',
      }),
    ];
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" />);
    const banner = getByTestId('task-blocked-banner');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('Blocked');
    expect(banner.textContent).toContain('Waiting for API key configuration');
  });

  it('shows blocked banner even when task has no result text', () => {
    mockTasks.value = [
      makeTask({ status: 'blocked', result: null, taskAgentSessionId: 'session-abc' }),
    ];
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" />);
    expect(getByTestId('task-blocked-banner')).toBeTruthy();
  });

  it('does not show blocked banner for non-blocked tasks', () => {
    mockTasks.value = [
      makeTask({
        status: 'in_progress',
        result: 'Some result',
        taskAgentSessionId: 'session-abc',
      }),
    ];
    const { queryByTestId } = render(<SpaceTaskPane taskId="task-1" />);
    expect(queryByTestId('task-blocked-banner')).toBeNull();
  });

  it('moves blocked status into the action bar instead of the header label', () => {
    mockTasks.value = [
      makeTask({
        status: 'blocked',
        result: 'Need human input',
        taskAgentSessionId: 'session-abc',
      }),
    ];
    const { getByTestId, queryByTestId } = render(<SpaceTaskPane taskId="task-1" />);
    expect(queryByTestId('task-status-label')).toBeNull();
    expect(getByTestId('task-blocked-banner').textContent).toContain('Blocked');
    expect(getByTestId('task-blocked-reopen-btn')).toBeTruthy();
    expect(getByTestId('task-blocked-cancel-btn')).toBeTruthy();
  });
});

function makeActivityMember(
  overrides: Partial<SpaceTaskActivityMember> = {}
): SpaceTaskActivityMember {
  return {
    id: 'member-1',
    sessionId: 'session-member-1',
    kind: 'node_agent',
    label: 'Task Agent',
    role: 'task-agent',
    state: 'active',
    messageCount: 3,
    nodeExecution: null,
    ...overrides,
  };
}

describe('SpaceTaskPane — activity members actions', () => {
  beforeEach(() => {
    cleanup();
    mockTasks.value = [];
    mockTaskActivity.value = new Map();
    mockEnsureTaskAgentSession.mockReset();
    mockEnsureTaskAgentSession.mockImplementation(async () =>
      makeTask({ status: 'in_progress', taskAgentSessionId: 'session-ensured' })
    );
    mockSubscribeTaskActivity.mockClear();
    mockUnsubscribeTaskActivity.mockClear();
    mockSpaceOverlaySessionIdSignal.value = null;
    mockSpaceOverlayAgentNameSignal.value = null;
    mockSpaceOverlayTaskContextSignal.value = null;
    mockCurrentSpaceTaskViewTabSignal.value = 'thread';
    mockCurrentSpaceIdSignal.value = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('does not show dropdown when task is archived and has no activity members', () => {
    mockTasks.value = [makeTask({ status: 'archived', taskAgentSessionId: 'session-abc' })];
    const { queryByTestId, queryByText } = render(<SpaceTaskPane taskId="task-1" />);
    expect(queryByTestId('task-actions-menu-trigger')).toBeNull();
    expect(queryByText('Open Task Agent (Active)')).toBeNull();
  });

  it('shows dropdown trigger when no activity members but task has valid transitions', () => {
    mockTasks.value = [makeTask({ status: 'open', taskAgentSessionId: 'session-abc' })];
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" />);
    expect(getByTestId('task-actions-menu-trigger')).toBeTruthy();
  });

  it('shows status transition actions in dropdown', () => {
    mockTasks.value = [makeTask({ status: 'done', taskAgentSessionId: 'session-abc' })];
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    expect(getByText('Reopen')).toBeTruthy();
    expect(getByText('Archive')).toBeTruthy();
  });

  it('calls updateTask when a transition action is clicked in the dropdown', async () => {
    mockTasks.value = [makeTask({ status: 'done', taskAgentSessionId: 'session-abc' })];
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Reopen'));
    await waitFor(() =>
      expect(mockUpdateTask).toHaveBeenCalledWith('task-1', { status: 'in_progress' })
    );
  });

  it('cancels blocked workflow tasks with a task status transition', async () => {
    mockTasks.value = [
      makeTask({
        status: 'blocked',
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-abc',
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', status: 'in_progress' })];
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);

    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByTestId('task-blocked-cancel-btn'));

    await waitFor(() =>
      expect(mockUpdateTask).toHaveBeenCalledWith('task-1', { status: 'cancelled' })
    );
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  it('uses workflow recovery action and label for workflow-backed terminal tasks', async () => {
    mockTasks.value = [
      makeTask({
        status: 'cancelled',
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-abc',
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', status: 'cancelled' })];
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);

    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Resume workflow'));

    await waitFor(() =>
      expect(mockRecoverWorkflowTask).toHaveBeenCalledWith('task-1', 'in_progress')
    );
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it('stops an in_progress workflow task with a plain updateTask call', async () => {
    mockTasks.value = [
      makeTask({
        status: 'in_progress',
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-abc',
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', status: 'in_progress' })];
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);

    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Stop'));

    await waitFor(() =>
      expect(mockUpdateTask).toHaveBeenCalledWith('task-1', { status: 'stopped' })
    );
    expect(mockRecoverWorkflowTask).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  it('resumes a stopped workflow task through workflow recovery', async () => {
    mockTasks.value = [
      makeTask({
        status: 'stopped',
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-abc',
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', status: 'blocked' })];
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);

    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Resume workflow'));

    await waitFor(() =>
      expect(mockRecoverWorkflowTask).toHaveBeenCalledWith('task-1', 'in_progress')
    );
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it('resumes a stopped standalone task with a plain updateTask call', async () => {
    mockTasks.value = [makeTask({ status: 'stopped', taskAgentSessionId: 'session-abc' })];
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);

    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Resume'));

    await waitFor(() =>
      expect(mockUpdateTask).toHaveBeenCalledWith('task-1', { status: 'in_progress' })
    );
    expect(mockRecoverWorkflowTask).not.toHaveBeenCalled();
  });

  it('shows divider between activity members and transition actions', () => {
    mockTasks.value = [makeTask({ status: 'done', taskAgentSessionId: 'session-abc' })];
    mockTaskActivity.value = new Map([
      ['task-1', [makeActivityMember({ id: 'm1', label: 'Task Agent', state: 'active' })]],
    ]);
    const { getByTestId, container } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    const dividers = container.querySelectorAll('.h-px.bg-dark-700');
    expect(dividers.length).toBeGreaterThan(0);
  });

  it('hides done and cancelled transitions when pendingCheckpointType is task_completion', () => {
    mockTasks.value = [
      makeTask({
        status: 'review',
        pendingCheckpointType: 'task_completion',
        taskAgentSessionId: 'session-abc',
      }),
    ];
    const { getByTestId, getByRole } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    const menu = getByRole('menu');
    expect(menu.textContent).not.toContain('Approve');
    expect(menu.textContent).not.toContain('Cancel');
    expect(menu.textContent).toContain('Reopen');
    expect(menu.textContent).toContain('Archive');
  });

  it('shows activity members as task action menu items with state', () => {
    mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-1',
            label: 'Task Agent',
            state: 'active',
          }),
          makeActivityMember({ id: 'm2', sessionId: 'sess-2', label: 'Coder', state: 'queued' }),
        ],
      ],
    ]);
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    expect(getByText('Open Task Agent (Active)')).toBeTruthy();
    expect(getByText('Open Coder (Queued)')).toBeTruthy();
  });

  it('keeps members with a cancelled node execution openable read-only (paused task)', () => {
    mockTasks.value = [makeTask({ status: 'open', taskAgentSessionId: 'session-abc' })];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-cancelled-exec',
            label: 'Coder',
            role: 'coder',
            state: 'interrupted',
            nodeExecution: {
              nodeExecutionId: 'ne-1',
              nodeId: 'node-coder',
              agentName: 'coder',
              status: 'cancelled',
            },
          }),
        ],
      ],
    ]);
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Open Coder (Interrupted)'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith('sess-cancelled-exec', 'Coder', undefined, {
      taskId: 'task-1',
      agentName: 'coder',
      sessionId: 'sess-cancelled-exec',
      readonly: true,
    });
  });

  it('opens a paused Task Agent member read-only instead of a live composer context', () => {
    mockTasks.value = [makeTask({ status: 'open', taskAgentSessionId: null })];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-paused-ta',
            kind: 'task_agent',
            label: 'Task Agent',
            role: 'task-agent',
            state: 'idle',
          }),
        ],
      ],
    ]);
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Open Task Agent (Idle)'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith('sess-paused-ta', 'Task Agent', undefined, {
      taskId: 'task-1',
      agentName: 'task-agent',
      sessionId: 'sess-paused-ta',
      readonly: true,
    });
  });

  it('keeps a live node agent on a running task openable with its live context', () => {
    mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'session-abc' })];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-live-coder',
            label: 'Coder',
            role: 'coder',
            state: 'active',
            nodeExecution: {
              nodeExecutionId: 'ne-live',
              nodeId: 'node-coder',
              agentName: 'coder',
              status: 'in_progress',
            },
          }),
        ],
      ],
    ]);
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Open Coder (Active)'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith('sess-live-coder', 'Coder', undefined, {
      taskId: 'task-1',
      agentName: 'coder',
      sessionId: 'sess-live-coder',
      workflowNodeId: 'node-coder',
      nodeExecutionId: 'ne-live',
    });
  });

  it('opens a Task Agent member matching the task pointer with a live (null) task context', () => {
    mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'sess-live-ta' })];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-live-ta',
            kind: 'task_agent',
            label: 'Task Agent',
            role: 'task-agent',
            state: 'active',
          }),
        ],
      ],
    ]);
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Open Task Agent (Active)'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith(
      'sess-live-ta',
      'Task Agent',
      undefined,
      null
    );
  });

  it('keeps an actively-processing Task Agent live after a restart cleared the task pointer', () => {
    mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: null })];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-rehydrated-ta',
            kind: 'task_agent',
            label: 'Task Agent',
            role: 'task-agent',
            state: 'active',
          }),
        ],
      ],
    ]);
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Open Task Agent (Active)'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith(
      'sess-rehydrated-ta',
      'Task Agent',
      undefined,
      null
    );
  });

  it('keeps a pointer-matching Task Agent live even when its derived state is idle', () => {
    mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: 'sess-idle-ta' })];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-idle-ta',
            kind: 'task_agent',
            label: 'Task Agent',
            role: 'task-agent',
            state: 'idle',
          }),
        ],
      ],
    ]);
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Open Task Agent (Idle)'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith(
      'sess-idle-ta',
      'Task Agent',
      undefined,
      null
    );
  });

  it('keeps a waiting-for-input Task Agent live with a cleared task pointer', () => {
    mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: null })];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-waiting-ta',
            kind: 'task_agent',
            label: 'Task Agent',
            role: 'task-agent',
            state: 'waiting_for_input',
          }),
        ],
      ],
    ]);
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Open Task Agent (Waiting)'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith(
      'sess-waiting-ta',
      'Task Agent',
      undefined,
      null
    );
  });

  it('opens the current post-approval worker live and historical workers read-only', () => {
    mockTasks.value = [
      makeTask({
        status: 'approved',
        taskAgentSessionId: null,
        postApprovalSessionId: 'sess-pa-current',
      }),
    ];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-pa-current',
            label: 'Reviewer',
            role: 'reviewer',
            state: 'idle',
            nodeExecution: {
              nodeExecutionId: null,
              nodeId: 'node-review',
              agentName: 'reviewer',
              status: undefined,
              isCurrentPostApproval: true,
            },
          }),
          makeActivityMember({
            id: 'm2',
            sessionId: 'sess-pa-historical',
            label: 'Reviewer',
            role: 'reviewer',
            state: 'idle',
            nodeExecution: {
              nodeExecutionId: null,
              nodeId: 'node-review',
              agentName: 'reviewer',
              status: undefined,
              isCurrentPostApproval: false,
            },
          }),
        ],
      ],
    ]);
    const { getByTestId, getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    const reviewerItems = getAllByText('Open Reviewer (Idle)');
    expect(reviewerItems).toHaveLength(2);
    fireEvent.click(reviewerItems[0]);
    expect(mockPushOverlayHistory).toHaveBeenCalledWith('sess-pa-current', 'Reviewer', undefined, {
      taskId: 'task-1',
      agentName: 'reviewer',
      sessionId: 'sess-pa-current',
      workflowNodeId: 'node-review',
    });
    fireEvent.click(reviewerItems[1]);
    expect(mockPushOverlayHistory).toHaveBeenLastCalledWith(
      'sess-pa-historical',
      'Reviewer',
      undefined,
      {
        taskId: 'task-1',
        agentName: 'reviewer',
        sessionId: 'sess-pa-historical',
        readonly: true,
      }
    );
  });

  it('keeps members of a rate-limited task live (cooldown status is a running status)', () => {
    mockTasks.value = [makeTask({ status: 'rate_limited', taskAgentSessionId: 'session-abc' })];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-cooling-coder',
            label: 'Coder',
            role: 'coder',
            state: 'cooldown',
            nodeExecution: {
              nodeExecutionId: 'ne-cooling',
              nodeId: 'node-coder',
              agentName: 'coder',
              status: 'in_progress',
            },
          }),
        ],
      ],
    ]);
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Open Coder (Cooldown)'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith('sess-cooling-coder', 'Coder', undefined, {
      taskId: 'task-1',
      agentName: 'coder',
      sessionId: 'sess-cooling-coder',
      workflowNodeId: 'node-coder',
      nodeExecutionId: 'ne-cooling',
    });
  });

  it('annotates read-only member entries with a resume hint', () => {
    mockTasks.value = [makeTask({ status: 'open', taskAgentSessionId: null })];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-readonly-hint',
            label: 'Coder',
            role: 'coder',
            state: 'idle',
          }),
        ],
      ],
    ]);
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    const item = getByText('Open Coder (Idle)').closest('button');
    expect(item?.title).toBe('Opens read-only — resume the task to chat');
  });

  it('still hides members whose node execution is pending', () => {
    mockTasks.value = [makeTask({ status: 'open', taskAgentSessionId: 'session-abc' })];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-pending-exec',
            label: 'Coder',
            state: 'queued',
            nodeExecution: {
              nodeExecutionId: 'ne-2',
              nodeId: 'node-coder',
              agentName: 'coder',
              status: 'pending',
            },
          }),
        ],
      ],
    ]);
    const { getByTestId, queryByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    expect(queryByText('Open Coder (Queued)')).toBeNull();
  });

  it('clicking an activity member action opens overlay with correct session and label', () => {
    mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-coder',
            label: 'Coder Agent',
            state: 'active',
          }),
        ],
      ],
    ]);
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Open Coder Agent (Active)'));
    expect(mockSpaceOverlaySessionIdSignal.value).toBe('sess-coder');
    expect(mockSpaceOverlayAgentNameSignal.value).toBe('Coder Agent');
  });

  it('shows only members for the current task (not other tasks)', () => {
    mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
    mockTaskActivity.value = new Map([
      ['task-1', [makeActivityMember({ id: 'm1', label: 'Task 1 Agent', state: 'active' })]],
      ['task-2', [makeActivityMember({ id: 'm2', label: 'Task 2 Agent', state: 'idle' })]],
    ]);
    const { getByTestId, getByText, queryByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    expect(getByText('Open Task 1 Agent (Active)')).toBeTruthy();
    expect(queryByText('Open Task 2 Agent (Idle)')).toBeNull();
  });

  it('calls subscribeTaskActivity when a taskId is provided', async () => {
    mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
    render(<SpaceTaskPane taskId="task-1" />);
    await waitFor(() => expect(mockSubscribeTaskActivity).toHaveBeenCalledWith('task-1'));
  });

  it('does not call subscribeTaskActivity when taskId is null', () => {
    render(<SpaceTaskPane taskId={null} />);
    expect(mockSubscribeTaskActivity).not.toHaveBeenCalled();
  });

  it('calls unsubscribeTaskActivity on unmount', async () => {
    mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
    const { unmount } = render(<SpaceTaskPane taskId="task-1" />);
    await waitFor(() => expect(mockSubscribeTaskActivity).toHaveBeenCalledWith('task-1'));
    unmount();
    expect(mockUnsubscribeTaskActivity).toHaveBeenCalledWith('task-1');
  });
});

describe('SpaceTaskPane — workflow-declared agents in dropdown', () => {
  beforeEach(() => {
    cleanup();
    mockTasks.value = [];
    mockWorkflows.value = [];
    mockWorkflowRuns.value = [];
    mockTaskActivity.value = new Map();
    mockEnsureTaskAgentSession.mockReset();
    mockEnsureTaskAgentSession.mockImplementation(async () =>
      makeTask({ status: 'in_progress', taskAgentSessionId: 'session-ensured' })
    );
    mockPushOverlayHistory.mockClear();
    mockPushOverlayHistoryForPendingAgent.mockClear();
    mockSpaceOverlaySessionIdSignal.value = null;
    mockSpaceOverlayAgentNameSignal.value = null;
    mockSpaceOverlayTaskContextSignal.value = null;
  });

  afterEach(() => {
    cleanup();
  });

  function makeWorkflowWithAgents(agentNames: string[]): SpaceWorkflow {
    return {
      id: 'workflow-1',
      spaceId: 'space-1',
      name: 'Coding Workflow',
      description: '',
      nodes: agentNames.map((name, i) => ({
        id: `node-${i + 1}`,
        name: `${name}-node`,
        agents: [{ agentId: `agent-${name}`, name }],
      })),
      startNodeId: 'node-1',
      channels: [],
      gates: [],
      tags: [],
      createdAt: 1000,
      updatedAt: 1000,
    } as SpaceWorkflow;
  }

  it('renders workflow-declared agents that have not spawned a session as "(Not started)"', async () => {
    mockTasks.value = [
      makeTask({
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-task',
        status: 'in_progress',
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    mockWorkflows.value = [makeWorkflowWithAgents(['coder', 'reviewer'])];
    mockTaskActivity.value = new Map([
      ['task-1', [makeActivityMember({ id: 'm1', label: 'Task Agent', state: 'active' })]],
    ]);

    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
    await waitFor(() => expect(getByTestId('task-actions-menu-trigger')).toBeTruthy());
    fireEvent.click(getByTestId('task-actions-menu-trigger'));

    expect(getByText('Open Task Agent (Active)')).toBeTruthy();
    expect(getByText('Open coder (Not started)')).toBeTruthy();
    expect(getByText('Open reviewer (Not started)')).toBeTruthy();
  });

  it('omits pending-agent slots for stopped tasks — overlays cannot send anyway', async () => {
    mockTasks.value = [
      makeTask({
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-task',
        status: 'stopped',
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    mockWorkflows.value = [makeWorkflowWithAgents(['coder', 'reviewer'])];
    mockTaskActivity.value = new Map([
      ['task-1', [makeActivityMember({ id: 'm1', label: 'Task Agent', state: 'active' })]],
    ]);

    const { getByTestId, getByText, queryByText } = render(
      <SpaceTaskPane taskId="task-1" spaceId="space-1" />
    );
    await waitFor(() => expect(getByTestId('task-actions-menu-trigger')).toBeTruthy());
    fireEvent.click(getByTestId('task-actions-menu-trigger'));

    expect(getByText('Open Task Agent (Active)')).toBeTruthy();
    expect(queryByText(/Not started/)).toBeNull();
    expect(mockPushOverlayHistoryForPendingAgent).not.toHaveBeenCalled();
  });

  it('renders workflow-declared (Not started) agents as clickable and routes to a pending-agent overlay', async () => {
    mockTasks.value = [
      makeTask({
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-task',
        status: 'in_progress',
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    mockWorkflows.value = [makeWorkflowWithAgents(['reviewer'])];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({
            id: 'm1',
            sessionId: 'sess-task-agent',
            label: 'Task Agent',
            state: 'active',
          }),
        ],
      ],
    ]);

    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
    await waitFor(() => expect(getByTestId('task-actions-menu-trigger')).toBeTruthy());
    fireEvent.click(getByTestId('task-actions-menu-trigger'));

    const reviewerItem = getByText('Open reviewer (Not started)').closest('button');
    expect(reviewerItem).toBeTruthy();
    expect(reviewerItem?.disabled).toBeFalsy();
    expect(reviewerItem?.title).toContain('reviewer');

    fireEvent.click(getByText('Open reviewer (Not started)'));
    expect(mockPushOverlayHistoryForPendingAgent).toHaveBeenCalledTimes(1);
    expect(mockPushOverlayHistoryForPendingAgent).toHaveBeenCalledWith(
      'task-1',
      'reviewer',
      'node-1'
    );
    expect(mockPushOverlayHistory).not.toHaveBeenCalled();
  });

  it('hides workflow-declared entry once the agent has a live activity member (avoids duplicate)', async () => {
    mockTasks.value = [
      makeTask({
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-task',
        status: 'in_progress',
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    mockWorkflows.value = [makeWorkflowWithAgents(['coder', 'reviewer'])];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({ id: 'm1', label: 'Task Agent', state: 'active' }),
          makeActivityMember({
            id: 'm2',
            sessionId: 'sess-coder',
            kind: 'node_agent',
            role: 'coder',
            label: 'Coder',
            state: 'active',
            nodeExecution: {
              nodeExecutionId: 'exec-coder',
              nodeId: 'node-1',
              agentName: 'coder',
              status: 'in_progress',
            },
          }),
        ],
      ],
    ]);

    const { getByTestId, getByText, queryByText } = render(
      <SpaceTaskPane taskId="task-1" spaceId="space-1" />
    );
    await waitFor(() => expect(getByTestId('task-actions-menu-trigger')).toBeTruthy());
    fireEvent.click(getByTestId('task-actions-menu-trigger'));

    expect(getByText('Open Coder (Active)')).toBeTruthy();
    expect(queryByText('Open coder (Not started)')).toBeNull();
    expect(getByText('Open reviewer (Not started)')).toBeTruthy();
  });

  it('hides pending members, opens cancelled ones read-only, and keeps their slot unduplicated', async () => {
    mockTasks.value = [
      makeTask({
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-task',
        status: 'in_progress',
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    mockWorkflows.value = [makeWorkflowWithAgents(['coder', 'reviewer'])];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          makeActivityMember({ id: 'm1', label: 'Task Agent', state: 'active' }),
          makeActivityMember({
            id: 'm2',
            sessionId: 'sess-cancelled',
            kind: 'node_agent',
            role: 'coder',
            label: 'Coder',
            state: 'interrupted',
            nodeExecution: {
              nodeExecutionId: 'exec-cancelled',
              nodeId: 'node-1',
              agentName: 'coder',
              status: 'cancelled',
            },
          }),
          makeActivityMember({
            id: 'm3',
            sessionId: 'sess-pending',
            kind: 'node_agent',
            role: 'reviewer',
            label: 'Reviewer',
            state: 'queued',
            nodeExecution: {
              nodeExecutionId: 'exec-pending',
              nodeId: 'node-2',
              agentName: 'reviewer',
              status: 'pending',
            },
          }),
        ],
      ],
    ]);
    const { getByTestId, getByText, queryByText } = render(
      <SpaceTaskPane taskId="task-1" spaceId="space-1" />
    );
    await waitFor(() => expect(getByTestId('task-actions-menu-trigger')).toBeTruthy());
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    expect(queryByText('Open Reviewer (Queued)')).toBeNull();
    expect(queryByText('Open coder (Not started)')).toBeNull();
    expect(getByText('Open reviewer (Not started)')).toBeTruthy();
    fireEvent.click(getByText('Open Coder (Interrupted)'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith('sess-cancelled', 'Coder', undefined, {
      taskId: 'task-1',
      agentName: 'coder',
      sessionId: 'sess-cancelled',
      readonly: true,
    });
  });

  it('does not render workflow-declared entries for tasks with no workflow run', () => {
    mockTasks.value = [makeTask({ workflowRunId: null, taskAgentSessionId: 'session-task' })];
    mockWorkflowRuns.value = [];
    mockWorkflows.value = [makeWorkflowWithAgents(['coder', 'reviewer'])];
    mockTaskActivity.value = new Map([
      ['task-1', [makeActivityMember({ id: 'm1', label: 'Task Agent', state: 'active' })]],
    ]);

    const { getByTestId, queryByText } = render(
      <SpaceTaskPane taskId="task-1" spaceId="space-1" />
    );
    fireEvent.click(getByTestId('task-actions-menu-trigger'));

    expect(queryByText('Open coder (Not started)')).toBeNull();
    expect(queryByText('Open reviewer (Not started)')).toBeNull();
  });
});

describe('SpaceTaskPane — composer canvas toggle layout', () => {
  beforeEach(() => {
    cleanup();
    mockTasks.value = [];
    mockWorkflowRuns.value = [];
    mockWorkflows.value = [];
    mockEnsureTaskAgentSession.mockReset();
    mockEnsureTaskAgentSession.mockImplementation(async () =>
      makeTask({ status: 'in_progress', taskAgentSessionId: 'session-ensured' })
    );
    mockNavigateToSpaceTask.mockClear();
    mockCurrentSpaceTaskViewTabSignal.value = 'thread';
    mockCurrentSpaceIdSignal.value = null;
    rightPanelTargetSignal.value = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the canvas toggle in the content surface instead of the composer or header', () => {
    mockTasks.value = [makeTask({ workflowRunId: 'run-1', taskAgentSessionId: 'session-abc' })];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    const { getByTestId, queryByTestId } = render(
      <SpaceTaskPane taskId="task-1" spaceId="space-1" />
    );

    const toggle = getByTestId('canvas-toggle');
    expect(queryByTestId('task-view-tab-pill')).toBeNull();
    expect(queryByTestId('task-view-toggle')).toBeNull();
    expect(toggle.className).toContain('rounded-full');

    const composer = getByTestId('task-session-chat-composer');
    expect(composer.contains(toggle)).toBe(false);
    expect(getByTestId('task-pane-content').contains(toggle)).toBe(true);
  });

  it('content canvas toggle opens canvas and the canvas overlay returns to thread', () => {
    mockTasks.value = [makeTask({ workflowRunId: 'run-1', taskAgentSessionId: 'session-abc' })];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    const { getByTestId, queryByTestId } = render(
      <SpaceTaskPane taskId="task-1" spaceId="space-1" />
    );

    expect(queryByTestId('task-view-toggle')).toBeNull();
    expect(getByTestId('task-session-chat-composer').contains(getByTestId('canvas-toggle'))).toBe(
      false
    );

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(queryByTestId('task-view-toggle')).toBeNull();
    expect(getByTestId('canvas-view')).toBeTruthy();
    expect(queryByTestId('task-session-chat-composer')).toBeNull();

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(queryByTestId('task-view-toggle')).toBeNull();
    expect(getByTestId('task-thread-panel')).toBeTruthy();
  });

  it('content canvas toggle is interactive', () => {
    mockCurrentSpaceIdSignal.value = 'space-1';
    mockTasks.value = [makeTask({ workflowRunId: 'run-1', taskAgentSessionId: 'session-abc' })];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('space-1', 'task-1', 'canvas', true);
  });

  it('falls back to task.spaceId for tab navigation when no route space id is available', () => {
    mockCurrentSpaceIdSignal.value = null;
    mockTasks.value = [
      makeTask({
        spaceId: 'task-space',
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-abc',
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" />);

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('task-space', 'task-1', 'canvas', true);
  });

  it('does not reserve top inset space for the thread now that controls live in the header', () => {
    mockTasks.value = [makeTask({ taskAgentSessionId: 'session-abc' })];
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

    const thread = getByTestId('space-task-unified-thread');
    expect(thread.getAttribute('data-top-inset')).toBe('');
    expect(Number(thread.getAttribute('data-bottom-inset-px'))).toBeGreaterThanOrEqual(144);
    expect(thread.getAttribute('data-bottom-inset')).toBe('');
    expect(thread.getAttribute('data-bottom-scroll-padding')).toBe('');
  });

  it('rebinds dynamic inset measurement when returning to the thread view', () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.getAttribute('data-testid') === 'task-session-chat-composer') {
        return { height: 220 } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };
    try {
      mockTasks.value = [makeTask({ workflowRunId: 'run-1', taskAgentSessionId: 'session-abc' })];
      mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
      const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
      fireEvent.click(getByTestId('canvas-toggle'));
      fireEvent.click(getByTestId('canvas-toggle'));

      const thread = getByTestId('space-task-unified-thread');
      expect(Number(thread.getAttribute('data-bottom-inset-px'))).toBe(236);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  it('renders the active banner outside task-pane-content so it is visible across tabs', () => {
    mockTasks.value = [
      makeTask({
        status: 'blocked',
        result: 'Waiting for API key',
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-abc',
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

    const banner = getByTestId('task-pane-banner');
    const contentWrapper = getByTestId('task-pane-content');
    expect(contentWrapper.contains(banner)).toBe(false);
    expect(banner.parentElement).toBe(contentWrapper.parentElement);

    expect(getByTestId('task-blocked-banner')).toBeTruthy();

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(getByTestId('task-pane-banner')).toBeTruthy();
    expect(getByTestId('task-blocked-banner')).toBeTruthy();

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(getByTestId('task-pane-banner')).toBeTruthy();
    expect(getByTestId('task-blocked-banner')).toBeTruthy();
  });

  it('does not render the banner block when no banner applies', () => {
    setupTaskWithActivity();
    const { queryByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

    expect(queryByTestId('task-pane-banner')).toBeNull();
  });
});

describe('SpaceTaskPane — submit for review modal', () => {
  beforeEach(() => {
    cleanup();
    mockTasks.value = [];
    mockUpdateTask.mockClear();
    mockSubmitForReview.mockReset();
    mockSubmitForReview.mockResolvedValue(undefined);
    mockEnsureTaskAgentSession.mockReset();
    mockEnsureTaskAgentSession.mockImplementation(async () =>
      makeTask({ status: 'in_progress', taskAgentSessionId: 'session-ensured' })
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('clicking "Submit for Review" opens the modal and does NOT call updateTask', () => {
    setupTaskWithActivity();
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Submit for Review'));

    expect(getByTestId('submit-for-review-modal-content')).toBeTruthy();
    expect(mockUpdateTask).not.toHaveBeenCalled();
    expect(mockSubmitForReview).not.toHaveBeenCalled();
  });

  it('confirming the modal calls spaceStore.submitForReview with the trimmed reason', async () => {
    setupTaskWithActivity();
    const { getByTestId, getByText, queryByTestId } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Submit for Review'));

    fireEvent.input(getByTestId('submit-for-review-reason'), {
      target: { value: '  please verify the migration  ' },
    });
    fireEvent.click(getByTestId('submit-for-review-confirm'));

    await waitFor(() =>
      expect(mockSubmitForReview).toHaveBeenCalledWith('task-1', 'please verify the migration')
    );
    expect(mockUpdateTask).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByTestId('submit-for-review-modal-content')).toBeNull());
  });

  it('confirming with empty reason passes null (matches the agent tool contract)', async () => {
    setupTaskWithActivity();
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Submit for Review'));

    fireEvent.click(getByTestId('submit-for-review-confirm'));

    await waitFor(() => expect(mockSubmitForReview).toHaveBeenCalledWith('task-1', null));
  });

  it('renders RPC error inside the modal so the user gets feedback even when the inline composer is hidden', async () => {
    mockSubmitForReview.mockRejectedValueOnce(new Error('Network down'));
    setupTaskWithActivity();
    const { getByTestId, getByText, findByTestId, queryByTestId } = render(
      <SpaceTaskPane taskId="task-1" />
    );
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    fireEvent.click(getByText('Submit for Review'));
    fireEvent.click(getByTestId('submit-for-review-confirm'));

    const errEl = await findByTestId('submit-for-review-error');
    expect(errEl.textContent).toContain('Network down');
    expect(queryByTestId('submit-for-review-modal-content')).toBeTruthy();
  });
});

describe('SpaceTaskPane — view follows activity, not status', () => {
  beforeEach(() => {
    cleanup();
    mockTasks.value = [];
    mockWorkflows.value = [];
    mockWorkflowRuns.value = [];
    mockTaskActivity.value = new Map();
    mockTaskMessageActivity.value = new Map();
    mockNodeExecutions.value = [];
    mockCurrentSpaceTaskViewTabSignal.value = 'thread';
    rightPanelTargetSignal.value = null;
  });

  afterEach(() => {
    cleanup();
  });

  const viewMatrix: Array<{
    label: string;
    status: SpaceTaskStatus;
    activity: number | null;
    workflowRunId?: string;
    expectThread: boolean;
  }> = [
    {
      label: 'paused task (open) with prior agent activity keeps the thread view',
      status: 'open',
      activity: 4,
      expectThread: true,
    },
    {
      label: 'open task that was never started shows the task information view',
      status: 'open',
      activity: 0,
      expectThread: false,
    },
    {
      label: 'open task while activity is unknown keeps the thread view',
      status: 'open',
      activity: null,
      expectThread: true,
    },
    {
      label: 'in_progress task without messages shows the task information view',
      status: 'in_progress',
      activity: 0,
      expectThread: false,
    },
    {
      label: 'task with a workflow run but zero messages shows the task information view',
      status: 'blocked',
      activity: 0,
      workflowRunId: 'run-1',
      expectThread: false,
    },
    {
      label: 'blocked task with history keeps the thread view',
      status: 'blocked',
      activity: 7,
      expectThread: true,
    },
    {
      label: 'cancelled task with history keeps the thread view',
      status: 'cancelled',
      activity: 2,
      expectThread: true,
    },
    {
      label: 'done task with history keeps the thread view',
      status: 'done',
      activity: 9,
      expectThread: true,
    },
    {
      label: 'draft task shows the task information view',
      status: 'draft',
      activity: 0,
      expectThread: false,
    },
    {
      label: 'stopped task with prior agent activity keeps the thread view',
      status: 'stopped',
      activity: 6,
      workflowRunId: 'run-1',
      expectThread: true,
    },
    {
      label: 'stopped task that was never started shows the task information view',
      status: 'stopped',
      activity: 0,
      workflowRunId: 'run-1',
      expectThread: false,
    },
  ];

  for (const { label, status, activity, workflowRunId, expectThread } of viewMatrix) {
    it(label, () => {
      mockTasks.value = [makeTask({ status, workflowRunId })];
      mockTaskMessageActivity.value =
        activity === null ? new Map() : new Map([['task-1', activity]]);
      const { queryByTestId } = render(<SpaceTaskPane taskId="task-1" />);
      expect(queryByTestId('space-task-unified-thread') !== null).toBe(expectThread);
      expect(queryByTestId('task-info-view') !== null).toBe(!expectThread);
    });
  }

  it('paused task with severed link pointers but message history keeps the thread view', () => {
    mockTasks.value = [makeTask({ status: 'open', workflowRunId: null, taskAgentSessionId: null })];
    mockTaskMessageActivity.value = new Map([['task-1', 5]]);
    const { queryByTestId } = render(<SpaceTaskPane taskId="task-1" />);
    expect(queryByTestId('space-task-unified-thread')).toBeTruthy();
    expect(queryByTestId('task-info-view')).toBeNull();
  });

  it('switches to the thread view when the first activity arrives', async () => {
    mockTasks.value = [makeTask({ status: 'in_progress' })];
    mockTaskMessageActivity.value = new Map([['task-1', 0]]);
    const { queryByTestId } = render(<SpaceTaskPane taskId="task-1" />);
    expect(queryByTestId('task-info-view')).toBeTruthy();
    mockTaskMessageActivity.value = new Map([['task-1', 2]]);
    await waitFor(() => expect(queryByTestId('space-task-unified-thread')).toBeTruthy());
    expect(queryByTestId('task-info-view')).toBeNull();
  });

  it('task information view surfaces description, workflow, and priority', () => {
    mockTasks.value = [
      makeTask({ status: 'open', priority: 'urgent', preferredWorkflowId: 'workflow-9' }),
    ];
    mockWorkflows.value = [
      {
        id: 'workflow-9',
        spaceId: 'space-1',
        name: 'Release Workflow',
        nodes: [],
      } as SpaceWorkflow,
    ];
    mockTaskMessageActivity.value = new Map([['task-1', 0]]);
    const { getByText, getAllByText } = render(<SpaceTaskPane taskId="task-1" />);
    expect(getByText('Task description')).toBeTruthy();
    expect(getByText('Release Workflow')).toBeTruthy();
    expect(getAllByText('Urgent Priority').length).toBeGreaterThan(0);
    expect(getAllByText('Open').length).toBeGreaterThan(0);
  });
});
