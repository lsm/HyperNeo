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

// Bridge objects: created in vi.hoisted so mock factories can reference them.
// Real Preact signals are assigned to .signal after module init so that mock
// functions called at test-runtime can update the reactive signal.
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
  // Bridges to hold real signals for reactive tab/id updates
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

// Real Preact signals — these enable reactivity for values read during render
const mockCurrentSpaceTaskViewTabSignal = signal<string>('thread');
const mockCurrentSpaceIdSignal = signal<string | null>(null);

// Wire bridges so mockNavigateToSpaceTask can update the real signals
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
      listGateData: vi.fn().mockResolvedValue([]),
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
    // Expose the onNodeClick for testing
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
mockNodeExecutions = signal<NodeExecution[]>([]);
mockNodeExecutionsByNodeId = signal<Map<string, unknown[]>>(new Map());

import { SpaceTaskPane } from '../SpaceTaskPane';
import { rightPanelTargetSignal } from '../../../lib/signals';

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

  it('shows unavailable-thread copy when no task session exists', () => {
    mockTasks.value = [makeTask({ status: 'in_progress', taskAgentSessionId: null })];
    const { getByText } = render(<SpaceTaskPane taskId="task-1" />);
    expect(getByText(/Task thread is not available/)).toBeTruthy();
    expect(getByText('Keep this view open while the task thread starts.')).toBeTruthy();
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
        undefined
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
        undefined
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
        undefined
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

    // Composer renders but send is disabled (no targets available)
    expect(queryByPlaceholderText('Select a target agent...')).toBeNull();
    const sendButton = queryByTestId('send-button');
    // Send button should be disabled or absent since canSendThreadMessage is false
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

    // First send fails
    fireEvent.input(textarea, { target: { value: 'First try' } });
    fireEvent.click(getByTestId('send-button'));
    await waitFor(() => expect(getByText('Temporary error')).toBeTruthy());

    // Second send succeeds — error should be cleared
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
    // task has workflowRunId but no run in the store → canvasWorkflowId is null
    mockTasks.value = [makeTask({ workflowRunId: 'run-1' })];
    mockWorkflowRuns.value = []; // no matching run
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
    // Thread view is shown initially
    expect(queryByTestId('canvas-view')).toBeNull();
    expect(queryByTestId('task-thread-panel')).toBeTruthy();

    fireEvent.click(getByTestId('canvas-toggle'));

    // Canvas view is now shown
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

  it('canvas node click does not open overlay when no node execution exists (task-agent fallback removed)', () => {
    mockTasks.value = [
      makeTask({
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-task',
        activeSession: null,
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    // No node executions → no overlay (task-agent fallback removed)
    mockNodeExecutionsByNodeId.value = new Map();
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(getByTestId('workflow-canvas')).toBeTruthy();

    // Simulate a node click — no node execution exists, no overlay
    mockWorkflowCanvasOnNodeClick('node-1', 'Coder Node', ['coder']);

    expect(mockSpaceOverlaySessionIdSignal.value).toBe(null);
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
    // node-1 has an activity member (node_agent) with a sessionId — mirrors the
    // "Agents" buttons which use taskActivity as their data source.
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

    // Simulate a node click — activity member exists with sessionId
    mockWorkflowCanvasOnNodeClick('node-1', 'Coder Node', ['coder']);

    // Should use the activity member's session, NOT the parent task's session
    expect(mockSpaceOverlaySessionIdSignal.value).toBe('session-node-agent');
    expect(mockSpaceOverlayAgentNameSignal.value).toBe('Coder Node');
    expect(mockSpaceOverlayTaskContextSignal.value).toEqual({
      taskId: 'task-1',
      agentName: 'coder',
      nodeExecutionId: 'exec-coder-1',
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

      // Change the title
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

      // Simulate task transitioning to done via another client
      mockTasks.value = [makeTask({ status: 'done' })];

      // Modal should be closed after the effect processes the status change
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
      // Open edit modal for task-1
      fireEvent.click(getByTestId('task-actions-menu-trigger'));
      fireEvent.click(getByText('Edit title, description, or priority'));
      expect(getByTestId('edit-task-modal-content')).toBeTruthy();

      // Switch to task-2
      rerender(<SpaceTaskPane taskId="task-2" />);

      // Edit modal should be closed
      expect(queryByTestId('edit-task-modal-content')).toBeNull();
    });
  });
  it('canvas node click matches by role (slot name), not by label — regression for Review node bug', () => {
    // This test reproduces the bug where clicking a "Review" node opened the Task Agent
    // session instead of the Reviewer session. The root cause was matching m.label against
    // agentDisplayNames rather than m.role against _agentSlotNames.
    // Here the activity member label ('Code Reviewer') differs from _agentSlotNames (['reviewer']),
    // but m.role === 'reviewer' matches correctly.
    mockTasks.value = [
      makeTask({
        id: 'task-1',
        workflowRunId: 'run-1',
        taskAgentSessionId: 'session-task',
        activeSession: null,
      }),
    ];
    mockWorkflowRuns.value = [makeWorkflowRun({ id: 'run-1', workflowId: 'workflow-1' })];
    // No agents in the store — ensures no accidental label-based fallback works
    mockAgents.value = [];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          {
            id: 'session-reviewer',
            sessionId: 'session-reviewer',
            kind: 'node_agent' as const,
            // label differs from slot name — this is what broke the old code
            label: 'Code Reviewer',
            role: 'reviewer',
            state: 'active' as const,
            messageCount: 2,
          },
        ],
      ],
    ]);
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);

    fireEvent.click(getByTestId('canvas-toggle'));
    expect(getByTestId('workflow-canvas')).toBeTruthy();

    // Click the "Review" node — slot name is 'reviewer'
    mockWorkflowCanvasOnNodeClick('node-review', 'Review', ['reviewer']);

    // Must open the reviewer's session, NOT the task agent's session
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
    // archived has no valid transitions and no activity members → dropdown trigger is not rendered
    expect(queryByTestId('task-actions-menu-trigger')).toBeNull();
    expect(queryByText('Open Task Agent (Active)')).toBeNull();
  });

  it('shows dropdown trigger when no activity members but task has valid transitions', () => {
    mockTasks.value = [makeTask({ status: 'open', taskAgentSessionId: 'session-abc' })];
    const { getByTestId } = render(<SpaceTaskPane taskId="task-1" />);
    // open has transitions → dropdown is visible even with no activity members
    expect(getByTestId('task-actions-menu-trigger')).toBeTruthy();
  });

  it('shows status transition actions in dropdown', () => {
    mockTasks.value = [makeTask({ status: 'done', taskAgentSessionId: 'session-abc' })];
    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" />);
    fireEvent.click(getByTestId('task-actions-menu-trigger'));
    // done → in_progress = 'Reopen', done → archived = 'Archive'
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
    // Scope assertions to the dropdown menu to avoid false positives from the
    // PendingTaskCompletionBanner which also renders an "Approve" button.
    const menu = getByRole('menu');
    // done (Approve) and cancelled (Cancel) are owned by the banner when pendingCheckpointType is set
    expect(menu.textContent).not.toContain('Approve');
    expect(menu.textContent).not.toContain('Cancel');
    // non-approval transitions stay visible in the dropdown
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
  // Regression for Task #133: the dropdown only listed agents that already had
  // a session (driven by `taskActivity`). Workflow agents that haven't been
  // activated yet — e.g. a `reviewer` whose node is gated behind an earlier
  // step — were invisible, even though Task Agent send_message can lazily
  // activate them on first contact. The dropdown now merges workflow.nodes
  // with activityMembers and surfaces inactive peers as `(Not started)`.

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
    // Only the task_agent has a live session; coder/reviewer haven't spawned.
    mockTaskActivity.value = new Map([
      ['task-1', [makeActivityMember({ id: 'm1', label: 'Task Agent', state: 'active' })]],
    ]);

    const { getByTestId, getByText } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
    // Wait for async fetchWorkflowDetail to resolve before opening the menu
    await waitFor(() => expect(getByTestId('task-actions-menu-trigger')).toBeTruthy());
    fireEvent.click(getByTestId('task-actions-menu-trigger'));

    expect(getByText('Open Task Agent (Active)')).toBeTruthy();
    expect(getByText('Open coder (Not started)')).toBeTruthy();
    expect(getByText('Open reviewer (Not started)')).toBeTruthy();
  });

  it('renders workflow-declared (Not started) agents as clickable and routes to a pending-agent overlay', async () => {
    // Task #139 regression fix: in #133 these entries were rendered as
    // disabled — that violated #133's own AC #4 ("clicking a declared-but-
    // not-spawned agent opens the chat overlay; the first message activates
    // the session"). The fix re-enables the click and routes it to the
    // pending-agent overlay variant (`pushOverlayHistoryForPendingAgent`)
    // which carries (taskId, agentName) instead of a sessionId — so the
    // overlay header reads "reviewer" and not the Task Agent thread.
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
    // Wait for async fetchWorkflowDetail to resolve before opening the menu
    await waitFor(() => expect(getByTestId('task-actions-menu-trigger')).toBeTruthy());
    fireEvent.click(getByTestId('task-actions-menu-trigger'));

    const reviewerItem = getByText('Open reviewer (Not started)').closest('button');
    expect(reviewerItem).toBeTruthy();
    // No longer disabled — the click is routed to the pending-agent overlay.
    expect(reviewerItem?.disabled).toBeFalsy();
    expect(reviewerItem?.title).toContain('reviewer');

    fireEvent.click(getByText('Open reviewer (Not started)'));
    // Click routes through pushOverlayHistoryForPendingAgent so the overlay
    // renders the pending-agent variant scoped to (taskId, agentName).
    // Crucially, pushOverlayHistory (session-mode) MUST NOT be invoked —
    // that would have surfaced the Task Agent's session under the peer's
    // label, which was the very bug #133 first introduced.
    expect(mockPushOverlayHistoryForPendingAgent).toHaveBeenCalledTimes(1);
    expect(mockPushOverlayHistoryForPendingAgent).toHaveBeenCalledWith('task-1', 'reviewer');
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
    // `coder` has a live session; `reviewer` does not. Only `reviewer` should
    // appear as (Not started); `coder` appears via its activity member.
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
          }),
        ],
      ],
    ]);

    const { getByTestId, getByText, queryByText } = render(
      <SpaceTaskPane taskId="task-1" spaceId="space-1" />
    );
    // Wait for async fetchWorkflowDetail to resolve before opening the menu
    await waitFor(() => expect(getByTestId('task-actions-menu-trigger')).toBeTruthy());
    fireEvent.click(getByTestId('task-actions-menu-trigger'));

    expect(getByText('Open Coder (Active)')).toBeTruthy();
    expect(queryByText('Open coder (Not started)')).toBeNull();
    expect(getByText('Open reviewer (Not started)')).toBeTruthy();
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

    // Thread view (default)
    expect(queryByTestId('task-view-toggle')).toBeNull();
    expect(getByTestId('task-session-chat-composer').contains(getByTestId('canvas-toggle'))).toBe(
      false
    );

    // Canvas view
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

    // The banner block sits between the header and the content wrapper —
    // its parent is the top-level pane container, NOT the content wrapper —
    // so it stays visible regardless of which tab is active.
    const banner = getByTestId('task-pane-banner');
    const contentWrapper = getByTestId('task-pane-content');
    expect(contentWrapper.contains(banner)).toBe(false);
    expect(banner.parentElement).toBe(contentWrapper.parentElement);

    // Banner content (the underlying TaskBlockedBanner) renders inside.
    expect(getByTestId('task-blocked-banner')).toBeTruthy();

    // Switching to Canvas and back must not unmount the banner.
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

// Submit-for-Review unification: the "Submit for Review" dropdown action must
// open the optional-reason modal and route through `spaceStore.submitForReview`
// (the unified RPC). It must NOT issue a bare `updateTask({status:'review'})`
// — that path is rejected by the daemon because it would skip stamping
// `pendingCheckpointType` / `pendingCompletionSubmittedByNodeId` /
// `pendingCompletionReason`, leaving `PendingTaskCompletionBanner` invisible.
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

    // Modal is open
    expect(getByTestId('submit-for-review-modal-content')).toBeTruthy();
    // Critical: the bare `→review` path must NOT have been used.
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
    // updateTask must not be touched even on success.
    expect(mockUpdateTask).not.toHaveBeenCalled();
    // Modal closes after a successful confirm.
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

    // Error surfaces inside the modal — not via threadSendError, which is
    // invisible when the inline composer isn't mounted.
    const errEl = await findByTestId('submit-for-review-error');
    expect(errEl.textContent).toContain('Network down');
    // Modal stays open so the user can retry.
    expect(queryByTestId('submit-for-review-modal-content')).toBeTruthy();
  });
});
