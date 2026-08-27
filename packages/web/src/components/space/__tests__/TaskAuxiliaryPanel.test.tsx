// @ts-nocheck
import type { Space, SpaceGoal, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockNavigateToSpaceEvolve,
  mockNavigateToSpaceGoals,
  mockSpace,
  mockTasks,
  mockGoals,
  mockWorkflows,
  mockWorkflowRuns,
  mockSchedules,
  mockEnsureConfigData,
  mockFetchEvolutionScope,
  mockUpdateTask,
  mockSubmitForReview,
  mockPublishTask,
  mockTaskDetails,
  mockEnsureTaskDetail,
} = vi.hoisted(() => {
  function makeSignal<T>(initial: T) {
    return { value: initial };
  }
  const workflows = makeSignal<SpaceWorkflow[]>([]);
  return {
    mockNavigateToSpaceEvolve: vi.fn(),
    mockNavigateToSpaceGoals: vi.fn(),
    mockSpace: makeSignal<Space | null>(null),
    mockTasks: makeSignal<SpaceTask[]>([]),
    mockGoals: makeSignal<SpaceGoal[]>([]),
    mockWorkflows: workflows,
    mockWorkflowRuns: makeSignal([]),
    mockSchedules: makeSignal([]),
    mockEnsureConfigData: vi.fn().mockResolvedValue(undefined),
    mockFetchEvolutionScope: vi.fn().mockResolvedValue({ id: 'scope-1', name: 'Launch Scope' }),
    mockUpdateTask: vi.fn().mockResolvedValue(undefined),
    mockSubmitForReview: vi.fn().mockResolvedValue(undefined),
    mockPublishTask: vi.fn().mockResolvedValue(undefined),
    mockTaskDetails: makeSignal(new Map()),
    mockEnsureTaskDetail: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('../../../lib/router', () => ({
  navigateToSpaceEvolve: mockNavigateToSpaceEvolve,
  navigateToSpaceGoals: mockNavigateToSpaceGoals,
}));

vi.mock('../../../lib/signals', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
  };
});

vi.mock('../TaskTimelineFeed', () => ({
  TaskTimelineFeed: ({ taskId }: { taskId: string }) => (
    <div data-testid="task-timeline" data-task-id={taskId} />
  ),
}));

vi.mock('../TaskArtifactsPanel', () => ({
  TaskArtifactsPanel: ({ runId, taskId }: { runId: string; taskId: string }) => (
    <div data-testid="task-artifacts" data-run-id={runId} data-task-id={taskId} />
  ),
}));

vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

vi.mock('../../../lib/space-store', () => ({
  spaceStore: {
    space: mockSpace,
    tasks: mockTasks,
    taskDetails: mockTaskDetails,
    ensureTaskDetail: mockEnsureTaskDetail,
    goals: mockGoals,
    workflows: mockWorkflows,
    workflowRuns: mockWorkflowRuns,
    schedules: mockSchedules,
    ensureConfigData: mockEnsureConfigData,
    fetchEvolutionScope: mockFetchEvolutionScope,
    updateTask: mockUpdateTask,
    submitForReview: mockSubmitForReview,
    publishTask: mockPublishTask,
  },
}));

import { TaskAuxiliaryPanel } from '../TaskAuxiliaryPanel';
import { currentSpaceGoalIdSignal, currentSpaceScopeIdSignal } from '../../../lib/signals';

const NOW = 1_700_000_000_000;

function makeTask(
  overrides: Partial<SpaceTask> & { descriptionTruncated?: boolean } = {}
): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    taskNumber: 42,
    title: 'Ship task panel',
    description: 'Add workflow controls',
    status: 'open',
    priority: 'high',
    labels: [],
    dependsOn: [],
    result: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    blockReason: null,
    approvalSource: null,
    approvalReason: null,
    approvedAt: null,
    pendingCheckpointType: null,
    reportedStatus: null,
    reportedSummary: null,
    ...overrides,
  };
}

function makeWorkflow(): SpaceWorkflow {
  return {
    id: 'workflow-1',
    spaceId: 'space-1',
    name: 'Coding Workflow',
    nodes: [],
    startNodeId: null,
    gates: [],
    tags: [],
    completionAutonomyLevel: 3,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('TaskAuxiliaryPanel', () => {
  beforeEach(() => {
    cleanup();
    mockSpace.value = {
      id: 'space-1',
      slug: 'space-1',
      workspacePath: '/tmp/workspace',
      name: 'Space',
      description: '',
      backgroundContext: '',
      instructions: '',
      defaultModel: 'space-default-model',
      sessionIds: [],
      status: 'active',
      paused: false,
      stopped: false,
      maxConcurrentTasks: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    mockTasks.value = [makeTask({ preferredWorkflowId: 'workflow-1' })];
    mockTaskDetails.value = new Map();
    mockGoals.value = [
      {
        id: 'goal-1',
        spaceId: 'space-1',
        title: 'Launch Goal',
        description: '',
        status: 'active',
        type: 'one_shot',
        priority: 'high',
        labels: [],
        metrics: {},
        summary: '',
        progress: 0,
        nextSteps: [],
        preferredWorkflowId: null,
        taskScheduleId: null,
        autoTriggerNext: false,
        pendingNextRun: false,
        activeTaskId: null,
        lastTaskId: null,
        lastCheckInAt: null,
        nextCheckInAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
      },
    ];
    mockWorkflows.value = [makeWorkflow()];
    mockWorkflowRuns.value = [];
    mockSchedules.value = [];
    mockEnsureConfigData.mockClear();
    mockFetchEvolutionScope.mockClear();
    mockUpdateTask.mockClear();
    mockUpdateTask.mockResolvedValue(undefined);
    mockSubmitForReview.mockClear();
    mockSubmitForReview.mockResolvedValue(undefined);
    mockPublishTask.mockClear();
    mockPublishTask.mockResolvedValue(undefined);
    mockNavigateToSpaceEvolve.mockClear();
    mockNavigateToSpaceGoals.mockClear();
    currentSpaceGoalIdSignal.value = null;
    currentSpaceScopeIdSignal.value = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a single scrolling view with header, badges, and kept sections', async () => {
    mockTasks.value = [
      makeTask({
        preferredWorkflowId: 'workflow-1',
        workflowRunId: 'run-1',
        goalId: 'goal-1',
        evolutionScopeId: 'scope-1',
        result: 'Done summary',
      }),
    ];
    const { getByText, getByTestId, queryByRole } = render(
      <TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />
    );

    expect(getByText('Ship task panel')).toBeTruthy();
    expect(getByText('#42')).toBeTruthy();
    expect(getByText('High Priority')).toBeTruthy();

    expect(getByText('Description')).toBeTruthy();
    expect(getByText('Launch Goal')).toBeTruthy();
    await waitFor(() => expect(getByText('Launch Scope')).toBeTruthy());
    expect(getByText('Done summary')).toBeTruthy();
    expect(getByTestId('task-timeline-section')).toBeTruthy();
    expect(getByTestId('task-artifacts-section')).toBeTruthy();

    for (const tab of ['Details', 'Workflow', 'Agents', 'Gates', 'Timeline', 'Log']) {
      expect(queryByRole('button', { name: tab })).toBeNull();
    }
  });

  it('does not render agents, gates, or log remnants', async () => {
    const { queryByText, queryByTestId } = render(
      <TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />
    );

    expect(queryByText('Agents')).toBeNull();
    expect(queryByText('Gates')).toBeNull();
    expect(queryByText('Required autonomy')).toBeNull();
    expect(queryByTestId('task-agent-model-node-1-coder')).toBeNull();
  });

  it('does not render the artifacts section without a workflow run', () => {
    const { queryByTestId } = render(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />);
    expect(queryByTestId('task-artifacts-section')).toBeNull();
  });

  it('autosaves the description on blur', async () => {
    const { getByPlaceholderText } = render(
      <TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />
    );

    const textarea = getByPlaceholderText('Add a description…') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'Updated description' } });
    fireEvent.blur(textarea);

    await waitFor(() =>
      expect(mockUpdateTask).toHaveBeenCalledWith('task-1', { description: 'Updated description' })
    );
  });

  it('keeps the description editor disabled while the full description is loading', () => {
    mockTasks.value = [makeTask({ descriptionTruncated: true })];

    const { getByPlaceholderText } = render(
      <TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />
    );

    const textarea = getByPlaceholderText('Add a description…') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  it('enables the description editor once the full detail is cached', () => {
    mockTasks.value = [makeTask({ descriptionTruncated: true })];
    mockTaskDetails.value = new Map([['task-1', makeTask({ description: 'full description' })]]);

    const { getByPlaceholderText } = render(
      <TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />
    );

    const textarea = getByPlaceholderText('Add a description…') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('full description');
  });

  it('persists a workflow selection from the Details row', async () => {
    const { getByTestId } = render(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />);

    const select = getByTestId('task-workflow-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'workflow-1' } });

    await waitFor(() =>
      expect(mockUpdateTask).toHaveBeenCalledWith('task-1', { preferredWorkflowId: 'workflow-1' })
    );
  });

  it('clears the preferred workflow when set to auto-select', async () => {
    const { getByTestId } = render(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />);

    const select = getByTestId('task-workflow-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() =>
      expect(mockUpdateTask).toHaveBeenCalledWith('task-1', { preferredWorkflowId: null })
    );
  });

  it('uses the route space id for goal and forge links', async () => {
    mockTasks.value = [makeTask({ goalId: 'goal-1', evolutionScopeId: 'scope-1' })];
    const { getByText } = render(
      <TaskAuxiliaryPanel spaceId="space-1" navigationSpaceId="space-slug" taskId="task-1" />
    );

    expect(getByText('Evolution scope')).toBeTruthy();
    fireEvent.click(getByText('Launch Goal'));
    await waitFor(() => expect(getByText('Launch Scope')).toBeTruthy());
    fireEvent.click(getByText('Launch Scope'));

    expect(mockNavigateToSpaceGoals).toHaveBeenCalledWith('space-slug');
    expect(mockNavigateToSpaceEvolve).toHaveBeenCalledWith('space-slug');
  });

  it('routes submit for review through submitForReview in the middle column', async () => {
    const { getByLabelText, getByText } = render(
      <TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" onClose={() => {}} />
    );

    fireEvent.click(getByLabelText('Task Actions'));
    fireEvent.click(getByText('Submit for Review'));

    await waitFor(() => expect(mockSubmitForReview).toHaveBeenCalledWith('task-1'));
    expect(mockUpdateTask).not.toHaveBeenCalledWith('task-1', { status: 'review' });
  });

  it('exposes the actions menu in the right-panel header too', async () => {
    const { getByLabelText, getByText } = render(
      <TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />
    );

    fireEvent.click(getByLabelText('Task Actions'));
    fireEvent.click(getByText('Submit for Review'));

    await waitFor(() => expect(mockSubmitForReview).toHaveBeenCalledWith('task-1'));
  });

  it('shows the back button only in the middle-column variant', () => {
    const { getByTestId, rerender } = render(
      <TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" onClose={() => {}} />
    );
    expect(getByTestId('task-back-button')).toBeTruthy();

    rerender(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />);
    expect(document.querySelector('[data-testid="task-back-button"]')).toBeNull();
  });

  it('renders a not-found state when the task is missing', () => {
    mockTasks.value = [];
    const { getByText } = render(<TaskAuxiliaryPanel spaceId="space-1" taskId="missing" />);
    expect(getByText('Task not found')).toBeTruthy();
  });

  it('shows depends-on rows inside the Details section', () => {
    mockTasks.value = [
      makeTask({
        dependsOn: ['task-2'],
        preferredWorkflowId: null,
      }),
      makeTask({ id: 'task-2', taskNumber: 7, title: 'Blocking task', preferredWorkflowId: null }),
    ];
    const { getByText } = render(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />);

    expect(getByText('Depends on')).toBeTruthy();
    expect(getByText('#7')).toBeTruthy();
    expect(getByText('Blocking task')).toBeTruthy();
  });

  it('scrolls to the focus section requested by a legacy deep-link', () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      render(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" focusSection="timeline" />);
      const timelineSection = document.querySelector('[data-testid="task-timeline-section"]');

      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'start' });
      expect(scrollSpy.mock.instances[0]).toBe(timelineSection);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('does not auto-scroll when no focus section is requested', () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      render(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />);
      expect(scrollSpy).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('shows the workflow run status when a run exists', () => {
    mockTasks.value = [
      makeTask({ status: 'done', workflowRunId: 'run-1', preferredWorkflowId: 'workflow-1' }),
    ];
    mockWorkflowRuns.value = [
      {
        id: 'run-1',
        spaceId: 'space-1',
        workflowId: 'workflow-1',
        title: 'Run',
        status: 'done',
        createdAt: NOW,
        startedAt: NOW,
        updatedAt: NOW,
        completedAt: NOW,
      },
    ];
    const { getByText } = render(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />);

    const runStatusRow = getByText('Run status').parentElement;
    expect(runStatusRow?.textContent).toContain('Succeeded');
  });

  it('shows the executed workflow when it differs from the configured one', () => {
    mockWorkflows.value = [
      makeWorkflow(),
      { ...makeWorkflow(), id: 'workflow-2', name: 'Review Workflow' },
    ];
    mockTasks.value = [
      makeTask({ status: 'done', workflowRunId: 'run-1', preferredWorkflowId: null }),
    ];
    mockWorkflowRuns.value = [
      {
        id: 'run-1',
        spaceId: 'space-1',
        workflowId: 'workflow-2',
        title: 'Run',
        status: 'done',
        createdAt: NOW,
        startedAt: NOW,
        updatedAt: NOW,
        completedAt: NOW,
      },
    ];
    const { getByText } = render(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />);

    const executedRow = getByText('Executed workflow').parentElement;
    expect(executedRow?.textContent).toContain('Review Workflow');
  });

  it('omits the executed-workflow row when it matches the configured workflow', () => {
    mockTasks.value = [
      makeTask({ status: 'done', workflowRunId: 'run-1', preferredWorkflowId: 'workflow-1' }),
    ];
    mockWorkflowRuns.value = [
      {
        id: 'run-1',
        spaceId: 'space-1',
        workflowId: 'workflow-1',
        title: 'Run',
        status: 'done',
        createdAt: NOW,
        startedAt: NOW,
        updatedAt: NOW,
        completedAt: NOW,
      },
    ];
    const { queryByText } = render(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />);

    expect(queryByText('Executed workflow')).toBeNull();
  });
});
