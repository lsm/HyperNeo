// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type {
  SpaceWorkerAgent,
  NodeExecution,
  SpaceTask,
  SpaceTaskActivityMember,
  SpaceWorkflow,
  SpaceWorkflowRun,
} from '@hyperneo/shared';

vi.mock('../../../lib/router', () => ({
  navigateToSpaceAgent: vi.fn(),
}));

const { mockSpaceOverlaySessionIdSignal, mockSpaceOverlayAgentNameSignal, mockThreadTurns } =
  vi.hoisted(() => ({
    mockSpaceOverlaySessionIdSignal: { value: null as string | null },
    mockSpaceOverlayAgentNameSignal: { value: null as string | null },
    mockThreadTurns: [] as Array<{
      agentLabel?: string;
      fromLabel?: string;
      toLabel?: string;
    }>,
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
  };
});

let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockAgents: ReturnType<typeof signal<SpaceWorkerAgent[]>>;
let mockWorkflows: ReturnType<typeof signal<SpaceWorkflow[]>>;
let mockWorkflowRuns: ReturnType<typeof signal<SpaceWorkflowRun[]>>;
let mockNodeExecutions: ReturnType<typeof signal<NodeExecution[]>>;
let mockTaskActivity: ReturnType<typeof signal<Map<string, SpaceTaskActivityMember[]>>>;

const mockUpdateTask = vi.fn().mockResolvedValue(undefined);
const mockEnsureTaskAgentSession = vi.fn();
const mockSendTaskMessage = vi.fn().mockResolvedValue(undefined);
const mockSubscribeTaskActivity = vi.fn().mockResolvedValue(undefined);
const mockUnsubscribeTaskActivity = vi.fn();

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      tasks: mockTasks,
      taskDetails: signal(new Map()),
      ensureTaskDetail: vi.fn().mockResolvedValue(null),
      agents: mockAgents,
      workflows: mockWorkflows,
      workflowRuns: mockWorkflowRuns,
      nodeExecutions: mockNodeExecutions,
      taskActivity: mockTaskActivity,
      hasTaskMessageActivity: () => null,
      updateTask: mockUpdateTask,
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

vi.mock('../SpaceTaskUnifiedThread', () => ({
  SpaceTaskUnifiedThread: ({ taskId }: { taskId: string }) => (
    <div data-testid="space-task-unified-thread" data-task-id={taskId}>
      <div>
        {mockThreadTurns.map((turn, index) => (
          <div
            key={index}
            data-testid="minimal-thread-turn"
            data-agent-label={turn.agentLabel}
            data-from-label={turn.fromLabel}
            data-to-label={turn.toLabel}
          />
        ))}
      </div>
    </div>
  ),
}));

vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

mockTasks = signal<SpaceTask[]>([]);
mockAgents = signal<SpaceWorkerAgent[]>([]);
mockWorkflows = signal<SpaceWorkflow[]>([]);
mockWorkflowRuns = signal<SpaceWorkflowRun[]>([]);
mockNodeExecutions = signal<NodeExecution[]>([]);
mockTaskActivity = signal<Map<string, SpaceTaskActivityMember[]>>(new Map());

import { SpaceTaskPane } from '../SpaceTaskPane';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
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

function makeWorkflowTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return makeTask({ workflowRunId: 'run-1', ...overrides });
}

describe('SpaceTaskPane — @mention autocomplete', () => {
  beforeEach(() => {
    cleanup();
    mockTasks.value = [];
    mockAgents.value = [
      {
        id: '1',
        name: 'Coder',
        spaceId: 'space-1',
        tools: [],
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: '2',
        name: 'Reviewer',
        spaceId: 'space-1',
        tools: [],
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    mockWorkflows.value = [
      {
        id: 'wf-1',
        spaceId: 'space-1',
        name: 'Default Workflow',
        nodes: [
          {
            id: 'node-1',
            name: 'Node 1',
            agents: [
              { agentId: '1', name: 'Coder' },
              { agentId: '2', name: 'Reviewer' },
            ],
          },
        ],
        channels: [],
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    mockWorkflowRuns.value = [
      {
        id: 'run-1',
        workflowId: 'wf-1',
        spaceId: 'space-1',
        status: 'running',
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    mockThreadTurns.length = 0;
    mockNodeExecutions.value = [
      {
        id: 'exec-coder',
        workflowRunId: 'run-1',
        workflowNodeId: 'node-1',
        agentName: 'Coder',
        status: 'idle',
        agentSessionId: 'session-coder',
        result: null,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'exec-reviewer',
        workflowRunId: 'run-1',
        workflowNodeId: 'node-1',
        agentName: 'Reviewer',
        status: 'idle',
        agentSessionId: 'session-reviewer',
        result: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    mockTaskActivity.value = new Map();
    mockEnsureTaskAgentSession.mockReset();
    mockEnsureTaskAgentSession.mockImplementation(async () =>
      makeWorkflowTask({ taskAgentSessionId: 'session-ensured' })
    );
    mockSendTaskMessage.mockClear();
    mockSubscribeTaskActivity.mockClear();
    mockUnsubscribeTaskActivity.mockClear();
    mockSpaceOverlaySessionIdSignal.value = null;
    mockSpaceOverlayAgentNameSignal.value = null;
  });

  afterEach(() => {
    cleanup();
  });

  function getTextarea(container: ReturnType<typeof render>) {
    return container.getByPlaceholderText(/^Message /) as HTMLTextAreaElement;
  }

  function typeIntoTextarea(textarea: HTMLTextAreaElement, value: string) {
    Object.defineProperty(textarea, 'selectionStart', {
      get: () => value.length,
      configurable: true,
    });
    fireEvent.input(textarea, { target: { value } });
  }

  async function waitForWorkflowLoaded(container: ReturnType<typeof render>) {
    await waitFor(() => {
      expect(container.getByTestId('task-composer-target-trigger').getAttribute('title')).toBe(
        'Send to Coder'
      );
    });
  }

  it('shows dropdown when user types @', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@');

    await waitFor(() => {
      expect(container.getByTestId('mention-autocomplete')).toBeTruthy();
    });
  });

  it('shows all workflow agents when @ is typed alone', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@');

    await waitFor(() => {
      const items = container.getAllByTestId('mention-item');
      expect(items.length).toBe(2);
      expect(items[0].textContent).toContain('@Coder');
      expect(items[1].textContent).toContain('@Reviewer');
    });
  });

  it('targets the first workflow agent by default when sending from a workflow task', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    expect(container.getByTestId('task-composer-target-trigger').getAttribute('title')).toBe(
      'Send to Coder'
    );
    typeIntoTextarea(textarea, 'Can you check this?');
    fireEvent.click(container.getByTestId('send-button'));

    await waitFor(() =>
      expect(mockSendTaskMessage).toHaveBeenCalledWith(
        'task-1',
        'Can you check this?',
        {
          kind: 'node_agent',
          agentName: 'Coder',
          nodeExecutionId: 'exec-coder',
          workflowNodeId: 'node-1',
        },
        undefined,
        'immediate'
      )
    );
  });

  it('sends to the manually selected workflow agent', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);

    fireEvent.click(container.getByTestId('task-composer-target-trigger'));
    const options = container.getAllByTestId('task-composer-target-option');
    fireEvent.click(options[1]);

    const textarea = getTextarea(container);
    expect(container.getByTestId('task-composer-target-trigger').getAttribute('title')).toBe(
      'Send to Reviewer'
    );
    typeIntoTextarea(textarea, 'Please review again');
    fireEvent.click(container.getByTestId('send-button'));

    await waitFor(() =>
      expect(mockSendTaskMessage).toHaveBeenCalledWith(
        'task-1',
        'Please review again',
        {
          kind: 'node_agent',
          agentName: 'Reviewer',
          nodeExecutionId: 'exec-reviewer',
          workflowNodeId: 'node-1',
        },
        undefined,
        'immediate'
      )
    );
    await waitFor(() =>
      expect(container.getByTestId('task-composer-target-trigger').getAttribute('title')).toBe(
        'Send to Coder'
      )
    );
  });

  it('routes to the worker (no nodeExecutionId) when activity omits the worker member but postApproval is durable', async () => {
    mockTasks.value = [
      makeWorkflowTask({
        postApprovalSourceNodeId: 'node-1',
        postApprovalSessionId: 'session-worker',
      }),
    ];
    mockWorkflows.value = [
      {
        id: 'wf-1',
        spaceId: 'space-1',
        name: 'Wf',
        nodes: [
          {
            id: 'node-1',
            name: 'Node 1',
            agents: [
              { agentId: '1', name: 'Coder' },
              { agentId: '2', name: 'Reviewer' },
            ],
            postApproval: { targetAgent: 'Coder', instructions: '' },
          },
        ],
        channels: [],
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    mockNodeExecutions.value = [
      {
        id: 'exec-coder',
        workflowRunId: 'run-1',
        workflowNodeId: 'node-1',
        agentName: 'Coder',
        status: 'idle',
        agentSessionId: 'session-coder',
        result: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);
    typeIntoTextarea(textarea, 'to the worker');
    fireEvent.click(container.getByTestId('send-button'));
    await waitFor(() =>
      expect(mockSendTaskMessage).toHaveBeenCalledWith(
        'task-1',
        'to the worker',
        {
          kind: 'node_agent',
          agentName: 'Coder',
          workflowNodeId: 'node-1',
        },
        undefined,
        'immediate'
      )
    );
  });

  it('keeps the sibling slot execution pin when a separator-distinct worker slot is active', async () => {
    mockTasks.value = [makeWorkflowTask()];
    mockWorkflows.value = [
      {
        id: 'wf-1',
        spaceId: 'space-1',
        name: 'Wf',
        nodes: [
          {
            id: 'node-1',
            name: 'Node 1',
            agents: [
              { agentId: '1', name: 'qa' },
              { agentId: '2', name: 'qa_one' },
            ],
          },
        ],
        channels: [],
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    mockNodeExecutions.value = [
      {
        id: 'exec-qa-one',
        workflowRunId: 'run-1',
        workflowNodeId: 'node-1',
        agentName: 'qa_one',
        status: 'idle',
        agentSessionId: 'session-qa-one',
        result: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          {
            id: 'm-qa',
            sessionId: 'session-qa',
            kind: 'node_agent' as const,
            label: 'QA',
            role: 'qa',
            state: 'active' as const,
            processingStatus: 'idle' as const,
            messageCount: 1,
            nodeExecution: {
              nodeExecutionId: 'exec-qa',
              nodeId: 'node-1',
              agentName: 'qa',
              status: 'in_progress' as const,
              isCurrentPostApproval: true,
            },
          },
        ],
      ],
    ]);
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitFor(() => expect(container.getByTestId('task-composer-target-trigger')).toBeTruthy());
    fireEvent.click(container.getByTestId('task-composer-target-trigger'));
    let options: HTMLElement[];
    await waitFor(() => {
      options = container.getAllByTestId('task-composer-target-option');
      expect(options.length).toBeGreaterThanOrEqual(2);
    });
    fireEvent.click(options[1]);
    const textarea = getTextarea(container);
    typeIntoTextarea(textarea, 'to qa_one');
    fireEvent.click(container.getByTestId('send-button'));
    await waitFor(() =>
      expect(mockSendTaskMessage).toHaveBeenCalledWith(
        'task-1',
        'to qa_one',
        {
          kind: 'node_agent',
          agentName: 'qa_one',
          nodeExecutionId: 'exec-qa-one',
          workflowNodeId: 'node-1',
        },
        undefined,
        'immediate'
      )
    );
  });

  it('keeps the worker durable-owned on the DECLARING node (not the submitter node) during an activity gap', async () => {
    mockTasks.value = [
      makeWorkflowTask({
        postApprovalSourceNodeId: 'node-1',
        postApprovalSessionId: 'session-worker',
      }),
    ];
    mockWorkflows.value = [
      {
        id: 'wf-1',
        spaceId: 'space-1',
        name: 'Wf',
        nodes: [
          {
            id: 'node-1',
            name: 'Submitter',
            agents: [{ agentId: '1', name: 'Coder' }],
          },
          {
            id: 'node-2',
            name: 'Declaring',
            agents: [{ agentId: 'qa-agent', name: 'qa' }],
            postApproval: { targetAgent: 'qa', instructions: '' },
          },
        ],
        channels: [],
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    mockTaskActivity.value = new Map();
    mockNodeExecutions.value = [
      {
        id: 'exec-coder',
        workflowRunId: 'run-1',
        workflowNodeId: 'node-1',
        agentName: 'Coder',
        status: 'idle',
        agentSessionId: 'session-coder',
        result: null,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'exec-qa',
        workflowRunId: 'run-1',
        workflowNodeId: 'node-2',
        agentName: 'qa',
        status: 'idle',
        agentSessionId: 'session-qa',
        result: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitFor(() => {
      fireEvent.click(container.getByTestId('task-composer-target-trigger'));
      const opts = container.getAllByTestId('task-composer-target-option');
      expect(opts.length).toBeGreaterThanOrEqual(2);
    });
    const qaOption = container
      .getAllByTestId('task-composer-target-option')
      .find((o) => (o.textContent ?? '').toLowerCase().includes('qa'));
    expect(qaOption).toBeTruthy();
    fireEvent.click(qaOption!);
    let textarea = getTextarea(container);
    typeIntoTextarea(textarea, 'to qa worker');
    fireEvent.click(container.getByTestId('send-button'));
    await waitFor(() =>
      expect(mockSendTaskMessage).toHaveBeenCalledWith(
        'task-1',
        'to qa worker',
        {
          kind: 'node_agent',
          agentName: 'qa',
          workflowNodeId: 'node-2',
        },
        undefined,
        'immediate'
      )
    );
    mockSendTaskMessage.mockClear();
    fireEvent.click(container.getByTestId('task-composer-target-trigger'));
    await waitFor(() => {
      const opts = container.getAllByTestId('task-composer-target-option');
      const coder = opts.find((o) => (o.textContent ?? '').includes('Coder'));
      expect(coder).toBeTruthy();
      coder && fireEvent.click(coder);
    });
    textarea = getTextarea(container);
    typeIntoTextarea(textarea, 'to coder');
    fireEvent.click(container.getByTestId('send-button'));
    await waitFor(() =>
      expect(mockSendTaskMessage).toHaveBeenCalledWith(
        'task-1',
        'to coder',
        {
          kind: 'node_agent',
          agentName: 'Coder',
          nodeExecutionId: 'exec-coder',
          workflowNodeId: 'node-1',
        },
        undefined,
        'immediate'
      )
    );
  });

  it('keeps a live sibling slot pinned on the worker declaring node (merger + coder)', async () => {
    mockTasks.value = [
      makeWorkflowTask({
        postApprovalSourceNodeId: 'node-1',
        postApprovalSessionId: 'session-merger',
      }),
    ];
    mockWorkflows.value = [
      {
        id: 'wf-1',
        spaceId: 'space-1',
        name: 'Wf',
        nodes: [
          {
            id: 'node-2',
            name: 'Declaring',
            agents: [
              { agentId: 'merger-agent', name: 'merger' },
              { agentId: 'coder-agent', name: 'coder' },
            ],
            postApproval: { targetAgent: 'merger', instructions: '' },
          },
        ],
        channels: [],
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    mockTaskActivity.value = new Map([
      [
        'task-1',
        [
          {
            id: 'm-merger',
            sessionId: 'session-merger',
            kind: 'node_agent' as const,
            label: 'Merger',
            role: 'merger',
            state: 'active' as const,
            processingStatus: 'idle' as const,
            messageCount: 1,
            nodeExecution: {
              nodeExecutionId: 'exec-merger',
              nodeId: 'node-2',
              agentName: 'merger',
              status: 'in_progress' as const,
              isCurrentPostApproval: true,
            },
          },
          {
            id: 'm-coder',
            sessionId: 'session-coder',
            kind: 'node_agent' as const,
            label: 'Coder',
            role: 'coder',
            state: 'active' as const,
            processingStatus: 'idle' as const,
            messageCount: 1,
            nodeExecution: {
              nodeExecutionId: 'exec-coder',
              nodeId: 'node-2',
              agentName: 'coder',
              status: 'in_progress' as const,
            },
          },
        ],
      ],
    ]);
    mockNodeExecutions.value = [
      {
        id: 'exec-coder',
        workflowRunId: 'run-1',
        workflowNodeId: 'node-2',
        agentName: 'coder',
        status: 'in_progress',
        agentSessionId: 'session-coder',
        result: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitFor(() => expect(container.getByTestId('task-composer-target-trigger')).toBeTruthy());
    fireEvent.click(container.getByTestId('task-composer-target-trigger'));
    let coderOption: HTMLElement | undefined;
    await waitFor(() => {
      const opts = container.getAllByTestId('task-composer-target-option');
      coderOption = opts.find((o) => (o.textContent ?? '').toLowerCase().includes('coder'));
      expect(coderOption).toBeTruthy();
    });
    fireEvent.click(coderOption!);
    const textarea = getTextarea(container);
    typeIntoTextarea(textarea, 'to coder');
    fireEvent.click(container.getByTestId('send-button'));
    await waitFor(() =>
      expect(mockSendTaskMessage).toHaveBeenCalledWith(
        'task-1',
        'to coder',
        {
          kind: 'node_agent',
          agentName: 'coder',
          nodeExecutionId: 'exec-coder',
          workflowNodeId: 'node-2',
        },
        undefined,
        'immediate'
      )
    );
  });

  it.skip('auto-targets the task agent when the visible turn is addressed to task agent', async () => {
    mockTasks.value = [makeWorkflowTask()];
    mockThreadTurns.push({ fromLabel: 'Coder Agent', toLabel: 'Task Agent agent' });
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () {
        if ((this as HTMLElement).getAttribute('data-testid') === 'minimal-thread-turn') {
          return { top: 20, bottom: 80, left: 0, right: 100, width: 100, height: 60 } as DOMRect;
        }
        return { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 } as DOMRect;
      });

    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);

    await waitFor(() =>
      expect(container.getByTestId('task-composer-target-trigger').getAttribute('title')).toBe(
        'Send to Task Agent'
      )
    );
    rectSpy.mockRestore();
  });

  it('auto-targets the lowest visible turn instead of a tall row extending below the viewport', async () => {
    mockTasks.value = [makeWorkflowTask()];
    mockThreadTurns.push(
      { fromLabel: 'Agent', toLabel: 'Coder Agent' },
      { fromLabel: 'Coder Agent', toLabel: 'Reviewer Agent' }
    );
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () {
        if ((this as HTMLElement).getAttribute('data-testid') === 'minimal-thread-turn') {
          const toLabel = (this as HTMLElement).dataset.toLabel;
          if (toLabel === 'Coder Agent') {
            return {
              top: 0,
              bottom: 1000,
              left: 0,
              right: 100,
              width: 100,
              height: 1000,
            } as DOMRect;
          }
          return { top: 80, bottom: 120, left: 0, right: 100, width: 100, height: 40 } as DOMRect;
        }
        return { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 } as DOMRect;
      });

    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);

    await waitFor(() =>
      expect(container.getByTestId('task-composer-target-trigger').getAttribute('title')).toBe(
        'Send to Reviewer'
      )
    );
    rectSpy.mockRestore();
  });

  it('releases a manual empty-composer target lock when the thread scrolls', async () => {
    mockTasks.value = [makeWorkflowTask()];
    mockThreadTurns.push({ fromLabel: 'Reviewer Agent', toLabel: 'Coder Agent' });
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () {
        if ((this as HTMLElement).getAttribute('data-testid') === 'minimal-thread-turn') {
          return { top: 20, bottom: 80, left: 0, right: 100, width: 100, height: 60 } as DOMRect;
        }
        return { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 } as DOMRect;
      });

    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);

    await waitFor(() =>
      expect(container.getByTestId('task-composer-target-trigger').getAttribute('title')).toBe(
        'Send to Coder'
      )
    );

    fireEvent.click(container.getByTestId('task-composer-target-trigger'));
    const options = container.getAllByTestId('task-composer-target-option');
    fireEvent.click(options[1]);
    expect(container.getByTestId('task-composer-target-trigger').getAttribute('title')).toBe(
      'Send to Reviewer'
    );

    const scroller = container.getByTestId('space-task-unified-thread').firstElementChild;
    expect(scroller).toBeTruthy();
    fireEvent.scroll(scroller as Element);

    await waitFor(() =>
      expect(container.getByTestId('task-composer-target-trigger').getAttribute('title')).toBe(
        'Send to Coder'
      )
    );
    rectSpy.mockRestore();
  });

  it('filters agents when @partial is typed', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@Co');

    await waitFor(() => {
      const items = container.getAllByTestId('mention-item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('@Coder');
    });
  });

  it('shows no dropdown when filter matches nothing', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@zzz');

    expect(container.queryByTestId('mention-autocomplete')).toBeNull();
  });

  it('hides dropdown when Escape is pressed', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@');

    await waitFor(() => {
      expect(container.getByTestId('mention-autocomplete')).toBeTruthy();
    });

    fireEvent.keyDown(textarea, { key: 'Escape' });

    await waitFor(() => {
      expect(container.queryByTestId('mention-autocomplete')).toBeNull();
    });
  });

  it('selects agent on Enter and inserts mention into textarea', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@Co');

    await waitFor(() => {
      expect(container.getByTestId('mention-autocomplete')).toBeTruthy();
    });

    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(container.queryByTestId('mention-autocomplete')).toBeNull();
    });
    expect(textarea.value).toContain('@Coder');
  });

  it('closes dropdown after clicking an agent name', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@');

    await waitFor(() => {
      expect(container.getByTestId('mention-autocomplete')).toBeTruthy();
    });

    const items = container.getAllByTestId('mention-item');
    fireEvent.click(items[0]);

    await waitFor(() => {
      expect(container.queryByTestId('mention-autocomplete')).toBeNull();
    });
  });

  it('inserts correct mention text when agent is clicked', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@Re');

    await waitFor(() => {
      expect(container.getAllByTestId('mention-item').length).toBeGreaterThan(0);
    });

    const items = container.getAllByTestId('mention-item');
    fireEvent.click(items[0]);

    await waitFor(() => {
      expect(textarea.value).toContain('@Reviewer');
    });
  });

  it('does not show dropdown when no @ is in the text', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, 'hello world');

    expect(container.queryByTestId('mention-autocomplete')).toBeNull();
  });

  it('navigates down in the dropdown list with ArrowDown', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@');

    await waitFor(() => {
      expect(container.getByTestId('mention-autocomplete')).toBeTruthy();
    });

    const itemsBefore = container.getAllByTestId('mention-item');
    expect(itemsBefore[0].className).toContain('bg-accent/20');

    fireEvent.keyDown(textarea, { key: 'ArrowDown' });

    await waitFor(() => {
      const items = container.getAllByTestId('mention-item');
      expect(items[1].className).toContain('bg-accent/20');
    });
  });

  it('does not select agent on Shift+Enter (allows newline insertion)', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@Co');

    await waitFor(() => {
      expect(container.getByTestId('mention-autocomplete')).toBeTruthy();
    });

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(container.queryByTestId('mention-autocomplete')).toBeTruthy();
    expect(textarea.value).toBe('@Co');
  });

  it('navigates up in the dropdown list with ArrowUp', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@');

    await waitFor(() => {
      expect(container.getByTestId('mention-autocomplete')).toBeTruthy();
    });

    fireEvent.keyDown(textarea, { key: 'ArrowDown' });

    await waitFor(() => {
      const items = container.getAllByTestId('mention-item');
      expect(items[1].className).toContain('bg-accent/20');
    });

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });

    await waitFor(() => {
      const items = container.getAllByTestId('mention-item');
      expect(items[0].className).toContain('bg-accent/20');
    });
  });

  it.skip('shows no @mention agents for tasks without a workflowRunId', async () => {
    mockTasks.value = [makeTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@');

    expect(container.queryByTestId('mention-autocomplete')).toBeNull();
  });

  it('shows only workflow agents when task has a workflowRunId', async () => {
    mockWorkflows.value = [
      {
        id: 'wf-1',
        spaceId: 'space-1',
        name: 'Scoped Workflow',
        nodes: [
          {
            id: 'node-1',
            name: 'Node 1',
            agents: [{ agentId: '1', name: 'Coder' }],
          },
        ],
        channels: [],
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    mockWorkflowRuns.value = [
      {
        id: 'run-1',
        workflowId: 'wf-1',
        spaceId: 'space-1',
        status: 'running',
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    mockTasks.value = [makeWorkflowTask()];

    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@');

    await waitFor(() => {
      const items = container.getAllByTestId('mention-item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('@Coder');
    });
  });

  it('shows only matching workflow agents when @partial matches a workflow agent', async () => {
    mockTasks.value = [makeWorkflowTask()];
    const container = render(<SpaceTaskPane taskId="task-1" />);
    await waitForWorkflowLoaded(container);
    const textarea = getTextarea(container);

    typeIntoTextarea(textarea, '@Re');

    await waitFor(() => {
      const items = container.getAllByTestId('mention-item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('@Reviewer');
    });

    const allItems = container.getAllByTestId('mention-item');
    expect(allItems.some((item) => item.textContent?.includes('@Coder'))).toBe(false);
  });
});
