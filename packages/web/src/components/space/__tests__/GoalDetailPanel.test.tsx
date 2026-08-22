import type { SpaceGoal, SpaceTask } from '@hyperneo/shared';
import type { Signal } from '@preact/signals';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockNavigateToSpaceTask, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockNavigateToSpaceTask: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('../../../lib/router', () => ({
  navigateToSpaceTask: mockNavigateToSpaceTask,
}));

vi.mock('../../../lib/toast', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

vi.mock('../../../lib/utils', () => ({
  cn: (...args: (string | false | null | undefined)[]) => args.filter(Boolean).join(' '),
}));

import { spaceStore } from '../../../lib/space-store';
import { GoalDetailPanel } from '../GoalDetailPanel';

const mockSpaceId = signal<string | null>('space-1');
const mockGoals = signal<SpaceGoal[]>([]);
const mockTasks = signal<SpaceTask[]>([]);
const mockWorkflows = signal<unknown[]>([]);
const mockPauseGoal = vi.fn();
const mockResumeGoal = vi.fn();
const mockArchiveGoal = vi.fn();
const mockCreateImmediateGoalTask = vi.fn();
const mockUpdateGoal = vi.fn();
const mockGetSchedule = vi.fn();
const mockUpsertGoal = vi.fn((goal: SpaceGoal) => {
  mockGoals.value = [goal, ...mockGoals.value.filter((current) => current.id !== goal.id)];
});

const mutableSpaceStore = spaceStore as unknown as {
  spaceId: Signal<string | null>;
  goals: Signal<SpaceGoal[]>;
  tasks: Signal<SpaceTask[]>;
  workflows: Signal<unknown[]>;
  pauseGoal: typeof mockPauseGoal;
  resumeGoal: typeof mockResumeGoal;
  archiveGoal: typeof mockArchiveGoal;
  createImmediateGoalTask: typeof mockCreateImmediateGoalTask;
  updateGoal: typeof mockUpdateGoal;
  getSchedule: typeof mockGetSchedule;
  upsertGoal: typeof mockUpsertGoal;
};

mutableSpaceStore.spaceId = mockSpaceId;
mutableSpaceStore.goals = mockGoals;
mutableSpaceStore.tasks = mockTasks;
mutableSpaceStore.workflows = mockWorkflows;
mutableSpaceStore.pauseGoal = mockPauseGoal;
mutableSpaceStore.resumeGoal = mockResumeGoal;
mutableSpaceStore.archiveGoal = mockArchiveGoal;
mutableSpaceStore.createImmediateGoalTask = mockCreateImmediateGoalTask;
mutableSpaceStore.updateGoal = mockUpdateGoal;
mutableSpaceStore.getSchedule = mockGetSchedule;
mutableSpaceStore.upsertGoal = mockUpsertGoal;

function makeGoal(overrides: Partial<SpaceGoal> = {}): SpaceGoal {
  const now = Date.now();
  return {
    id: 'goal-1',
    spaceId: 'space-1',
    title: 'Keep release healthy',
    description: 'Maintain release train',
    status: 'active',
    type: 'recurring',
    priority: 'high',
    labels: ['release'],
    metrics: { open_bugs: 3 },
    summary: 'Builds are green',
    progress: 45,
    nextSteps: ['Watch CI'],
    preferredWorkflowId: null,
    taskScheduleId: 'schedule-1',
    autoTriggerNext: true,
    pendingNextRun: false,
    activeTaskId: null,
    lastTaskId: 'task-1',
    lastCheckInAt: now - 60_000,
    nextCheckInAt: now + 60_000,
    createdAt: now - 120_000,
    updatedAt: now,
    completedAt: null,
    revision: 3,
    ...overrides,
  };
}

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  const now = Date.now();
  return {
    id: 'task-1',
    spaceId: 'space-1',
    taskNumber: 42,
    title: 'Investigate flaky build',
    description: '',
    status: 'done',
    priority: 'high',
    labels: ['goal'],
    dependsOn: [],
    goalId: 'goal-1',
    result: 'Fixed retry path',
    startedAt: now - 120_000,
    completedAt: now - 60_000,
    archivedAt: null,
    blockReason: null,
    approvalSource: null,
    approvalReason: null,
    approvedAt: null,
    pendingCheckpointType: null,
    reportedStatus: null,
    reportedSummary: null,
    createdAt: now - 180_000,
    updatedAt: now - 60_000,
    terminalGeneration: 1,
    ...overrides,
  };
}

function formatGoalDate(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

describe('GoalDetailPanel', () => {
  beforeEach(() => {
    mockSpaceId.value = 'space-1';
    mockGoals.value = [makeGoal()];
    mockTasks.value = [makeTask()];
    mockWorkflows.value = [];
    mockPauseGoal.mockImplementation(async (goalId: string) =>
      makeGoal({ id: goalId, status: 'paused' })
    );
    mockResumeGoal.mockImplementation(async (goalId: string) =>
      makeGoal({ id: goalId, status: 'active' })
    );
    mockArchiveGoal.mockImplementation(async (goalId: string) =>
      makeGoal({ id: goalId, status: 'archived' })
    );
    mockCreateImmediateGoalTask.mockImplementation(async (goalId: string) => ({
      goal: makeGoal({ id: goalId }),
      task: null,
      queued: false,
    }));
    mockUpdateGoal.mockImplementation(async (goalId: string, params: Partial<SpaceGoal>) =>
      makeGoal({ id: goalId, title: params.title ?? 'Updated goal' })
    );
    vi.clearAllMocks();
    mockGetSchedule.mockResolvedValue(null);
  });

  afterEach(() => cleanup());

  it('keeps goal lifecycle controls writable from the right panel', async () => {
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(mockPauseGoal).toHaveBeenCalledWith('goal-1'));

    mockGoals.value = [makeGoal({ status: 'paused' })];
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(mockResumeGoal).toHaveBeenCalledWith('goal-1'));

    mockGoals.value = [makeGoal({ status: 'active' })];
    fireEvent.click(await screen.findByRole('button', { name: 'Create task now' }));
    await waitFor(() => expect(mockCreateImmediateGoalTask).toHaveBeenCalledWith('goal-1'));
    expect(mockToastSuccess).toHaveBeenCalledWith('Goal task created');

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(mockArchiveGoal).toHaveBeenCalledWith('goal-1'));
  });

  it('shows recurring activity and metrics instead of progress', () => {
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    expect(screen.getByText('Activity')).toBeTruthy();
    expect(screen.getByText('Metric trajectory')).toBeTruthy();
    expect(screen.getByText('open_bugs: 3')).toBeTruthy();
    expect(screen.queryByText('45% complete')).toBeNull();
  });

  it('uses linked task activity for recurring goal status and last activity', () => {
    const now = Date.now();
    mockGoals.value = [makeGoal({ activeTaskId: null, lastTaskId: 'task-1', lastCheckInAt: null })];
    mockTasks.value = [makeTask({ updatedAt: now })];

    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText(formatGoalDate(now))).toBeTruthy();
  });

  it('shows progress for one-shot goals', () => {
    mockGoals.value = [makeGoal({ type: 'one_shot' })];

    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    expect(screen.getByText('Progress')).toBeTruthy();
    expect(screen.getByText('45% complete')).toBeTruthy();
  });

  it('opens the edit dialog from the right panel', async () => {
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.input(await screen.findByDisplayValue('Keep release healthy'), {
      target: { value: 'Updated goal title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal' }));

    await waitFor(() => expect(mockUpdateGoal).toHaveBeenCalled());
    expect(mockUpdateGoal).toHaveBeenCalledWith(
      'goal-1',
      expect.objectContaining({ title: 'Updated goal title' })
    );
  });

  it('navigates to linked tasks from goal detail', () => {
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    fireEvent.click(screen.getByRole('button', { name: /Investigate flaky build/ }));

    expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('space-1', 'task-1');
  });

  it('uses the route space id for linked task navigation', () => {
    render(<GoalDetailPanel spaceId="space-1" navigationSpaceId="space-slug" goalId="goal-1" />);

    fireEvent.click(screen.getByRole('button', { name: /Investigate flaky build/ }));

    expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('space-slug', 'task-1');
  });
});
