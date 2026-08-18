import type { SpaceGoal, SpaceGoalEvent, SpaceTask } from '@hyperneo/shared';
import type { Signal } from '@preact/signals';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGoals = signal<SpaceGoal[]>([]);
const mockGoalEvents = signal<Map<string, SpaceGoalEvent[]>>(new Map());
const mockTasks = signal<SpaceTask[]>([]);
const mockWorkflows = signal<unknown[]>([]);
const mockListGoals = vi.fn(async () => [] as SpaceGoal[]);
const mockListGoalEvents = vi.fn(async () => [] as SpaceGoalEvent[]);
const mockEnsureConfigData = vi.fn(async () => {});
const mockPauseGoal = vi.fn();
const mockResumeGoal = vi.fn();
const mockArchiveGoal = vi.fn();
const mockCreateImmediateGoalTask = vi.fn();
const mockCreateGoal = vi.fn();
const mockUpdateGoal = vi.fn();
const mockGetSchedule = vi.fn();

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
  getRelativeTime: () => '1m ago',
}));

import { currentSpaceGoalIdSignal, rightPanelTargetSignal } from '../../../lib/signals';
import { spaceStore } from '../../../lib/space-store';
import { SpaceGoalDialog } from '../SpaceGoalDialog';
import { SpaceGoals } from '../SpaceGoals';

const mutableSpaceStore = spaceStore as unknown as {
  goals: Signal<SpaceGoal[]>;
  goalEvents: Signal<Map<string, SpaceGoalEvent[]>>;
  tasks: Signal<SpaceTask[]>;
  workflows: Signal<unknown[]>;
  listGoals: typeof mockListGoals;
  listGoalEvents: typeof mockListGoalEvents;
  ensureConfigData: typeof mockEnsureConfigData;
  pauseGoal: typeof mockPauseGoal;
  resumeGoal: typeof mockResumeGoal;
  archiveGoal: typeof mockArchiveGoal;
  createImmediateGoalTask: typeof mockCreateImmediateGoalTask;
  createGoal: typeof mockCreateGoal;
  updateGoal: typeof mockUpdateGoal;
  getSchedule: typeof mockGetSchedule;
};

mutableSpaceStore.goals = mockGoals;
mutableSpaceStore.goalEvents = mockGoalEvents;
mutableSpaceStore.tasks = mockTasks;
mutableSpaceStore.workflows = mockWorkflows;
mutableSpaceStore.listGoals = mockListGoals;
mutableSpaceStore.listGoalEvents = mockListGoalEvents;
mutableSpaceStore.ensureConfigData = mockEnsureConfigData;
mutableSpaceStore.pauseGoal = mockPauseGoal;
mutableSpaceStore.resumeGoal = mockResumeGoal;
mutableSpaceStore.archiveGoal = mockArchiveGoal;
mutableSpaceStore.createImmediateGoalTask = mockCreateImmediateGoalTask;
mutableSpaceStore.createGoal = mockCreateGoal;
mutableSpaceStore.updateGoal = mockUpdateGoal;
mutableSpaceStore.getSchedule = mockGetSchedule;

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

function makeEvent(overrides: Partial<SpaceGoalEvent> = {}): SpaceGoalEvent {
  return {
    id: 'event-1',
    spaceId: 'space-1',
    goalId: 'goal-1',
    eventType: 'task_terminal',
    source: 'system',
    sourceTaskId: 'task-1',
    sourceSessionId: null,
    previousState: null,
    newState: null,
    diff: null,
    note: 'Task completed',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('SpaceGoals', () => {
  beforeEach(() => {
    mockGoals.value = [];
    mockGoalEvents.value = new Map();
    mockTasks.value = [];
    mockWorkflows.value = [];
    mockListGoals.mockResolvedValue([]);
    mockListGoalEvents.mockResolvedValue([]);
    mockEnsureConfigData.mockResolvedValue(undefined);
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
    mockCreateGoal.mockImplementation(async (params: Partial<SpaceGoal>) =>
      makeGoal({ id: 'goal-created', title: params.title ?? 'Created goal' })
    );
    mockUpdateGoal.mockImplementation(async (goalId: string, params: Partial<SpaceGoal>) =>
      makeGoal({ id: goalId, title: params.title ?? 'Updated goal' })
    );
    mockGetSchedule.mockResolvedValue(null);
    currentSpaceGoalIdSignal.value = null;
    rightPanelTargetSignal.value = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    currentSpaceGoalIdSignal.value = null;
    rightPanelTargetSignal.value = null;
  });

  it('renders goal cards and seeds the selected goal for the right panel', async () => {
    const goal = makeGoal();
    mockGoals.value = [goal];
    mockTasks.value = [makeTask()];
    mockGoalEvents.value = new Map([[goal.id, [makeEvent()]]]);

    render(<SpaceGoals spaceId="space-1" />);

    expect(await screen.findByText('Keep release healthy')).toBeTruthy();
    expect(screen.queryByText('45% complete')).toBeNull();
    expect(screen.getByText('Activity')).toBeTruthy();
    expect(screen.getByText('Metrics: open_bugs: 3')).toBeTruthy();
    expect(screen.getByText('Builds are green')).toBeTruthy();
    expect(screen.getByText('Recurring')).toBeTruthy();
    expect(screen.getByTestId('space-goals-introduction')).toBeTruthy();
    expect(screen.getByTestId('space-goal-count').textContent).toBe('1');
    await waitFor(() => expect(currentSpaceGoalIdSignal.value).toBe(goal.id));
    expect(mockListGoals).toHaveBeenCalledWith({ includeArchived: false });
  });

  it('uses active task time for recurring last activity', async () => {
    const now = Date.now();
    const goal = makeGoal({
      activeTaskId: 'task-active',
      lastTaskId: 'task-old',
      lastCheckInAt: null,
    });
    const activeTask = makeTask({ id: 'task-active', title: 'Active goal task', updatedAt: now });
    const oldTask = makeTask({
      id: 'task-old',
      title: 'Old goal task',
      updatedAt: now - 86_400_000,
    });
    mockGoals.value = [goal];
    mockTasks.value = [oldTask, activeTask];

    render(<SpaceGoals spaceId="space-1" />);

    expect(await screen.findByText('Keep release healthy')).toBeTruthy();
    expect(screen.getByText(`Last activity: ${formatGoalDate(now)}`)).toBeTruthy();
    expect(screen.getByText('Active goal task')).toBeTruthy();
  });

  it('keeps progress UI for one-shot and measurable goals', async () => {
    mockGoals.value = [makeGoal({ type: 'one_shot' })];

    render(<SpaceGoals spaceId="space-1" />);

    expect(await screen.findByText('Keep release healthy')).toBeTruthy();
    expect(screen.getByText('45% complete')).toBeTruthy();
  });

  it('writes the current goal selection for the right-panel toggle', async () => {
    const now = Date.now();
    mockGoals.value = [
      makeGoal({ updatedAt: now }),
      makeGoal({ id: 'goal-2', title: 'Second goal', updatedAt: now - 1 }),
    ];

    const { unmount } = render(<SpaceGoals spaceId="space-1" />);

    await waitFor(() => expect(currentSpaceGoalIdSignal.value).toBe('goal-1'));
    fireEvent.click(screen.getByRole('button', { name: /Second goal/ }));
    expect(currentSpaceGoalIdSignal.value).toBe('goal-2');
    expect(rightPanelTargetSignal.value).toEqual({
      type: 'goal',
      spaceId: 'space-1',
      goalId: 'goal-2',
    });

    rightPanelTargetSignal.value = { type: 'goal', spaceId: 'space-1', goalId: 'goal-2' };
    unmount();

    expect(currentSpaceGoalIdSignal.value).toBeNull();
    expect(rightPanelTargetSignal.value).toBeNull();
  });

  it('reloads goals when archived objectives are shown', async () => {
    mockGoals.value = [makeGoal()];

    render(<SpaceGoals spaceId="space-1" />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Show archived' }));

    await waitFor(() => {
      expect(mockListGoals).toHaveBeenCalledWith({ includeArchived: true });
    });
  });

  it('creates a goal from the dialog payload', async () => {
    render(<SpaceGoals spaceId="space-1" />);

    fireEvent.click(await screen.findByText('Create goal'));
    fireEvent.input(screen.getByPlaceholderText('Keep release train healthy'), {
      target: { value: 'Ship beta' },
    });
    fireEvent.input(screen.getByPlaceholderText('release, health'), {
      target: { value: 'beta, launch' },
    });
    fireEvent.input(screen.getByPlaceholderText(/build_health: green/), {
      target: {
        value:
          'open_bugs: 2\nhealthy: true\nunset: null\ncode: "0012"\nobject: {"foo": 1}\narray: [1,2]',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));

    await waitFor(() => expect(mockCreateGoal).toHaveBeenCalled());
    expect(mockCreateGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Ship beta',
        labels: ['beta', 'launch'],
        metrics: {
          open_bugs: 2,
          healthy: true,
          unset: null,
          code: '0012',
          object: '{"foo": 1}',
          array: '[1,2]',
        },
      })
    );
  });
});

describe('SpaceGoalDialog schedule editing', () => {
  beforeEach(() => {
    mockGetSchedule.mockResolvedValue(null);
    mockUpdateGoal.mockImplementation(async (goalId: string) => makeGoal({ id: goalId }));
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('pre-fills the linked schedule and sends the cron change on save', async () => {
    mockGetSchedule.mockResolvedValue({
      id: 'schedule-1',
      cronExpression: '0 9 * * 1',
      timezone: 'UTC',
    });

    render(<SpaceGoalDialog isOpen goal={makeGoal()} onClose={() => {}} />);

    const cronInput = await screen.findByPlaceholderText('@daily or 0 9 * * 1');
    await waitFor(() => expect((cronInput as HTMLInputElement).value).toBe('0 9 * * 1'));

    fireEvent.input(cronInput, { target: { value: '@hourly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal' }));

    await waitFor(() => expect(mockUpdateGoal).toHaveBeenCalled());
    expect(mockUpdateGoal).toHaveBeenCalledWith(
      'goal-1',
      expect.objectContaining({ checkInCronExpression: '@hourly' })
    );
  });

  it('omits the schedule change when the cron is untouched', async () => {
    mockGetSchedule.mockResolvedValue({
      id: 'schedule-1',
      cronExpression: '0 9 * * 1',
      timezone: 'UTC',
    });

    render(<SpaceGoalDialog isOpen goal={makeGoal()} onClose={() => {}} />);

    const cronInput = await screen.findByPlaceholderText('@daily or 0 9 * * 1');
    await waitFor(() => expect((cronInput as HTMLInputElement).value).toBe('0 9 * * 1'));

    fireEvent.input(screen.getByPlaceholderText('Rolling state summary'), {
      target: { value: 'Updated summary' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal' }));

    await waitFor(() => expect(mockUpdateGoal).toHaveBeenCalled());
    const [, params] = mockUpdateGoal.mock.calls[0];
    expect(params).not.toHaveProperty('checkInCronExpression');
    expect(params).not.toHaveProperty('checkInTimezone');
  });

  it('clears the schedule when the cron is emptied', async () => {
    mockGetSchedule.mockResolvedValue({
      id: 'schedule-1',
      cronExpression: '0 9 * * 1',
      timezone: 'UTC',
    });

    render(<SpaceGoalDialog isOpen goal={makeGoal()} onClose={() => {}} />);

    const cronInput = await screen.findByPlaceholderText('@daily or 0 9 * * 1');
    await waitFor(() => expect((cronInput as HTMLInputElement).value).toBe('0 9 * * 1'));

    fireEvent.input(cronInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal' }));

    await waitFor(() => expect(mockUpdateGoal).toHaveBeenCalled());
    expect(mockUpdateGoal).toHaveBeenCalledWith(
      'goal-1',
      expect.objectContaining({ checkInCronExpression: null })
    );
  });

  it('preserves a cron typed during the async schedule fetch', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    mockGetSchedule.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    render(<SpaceGoalDialog isOpen goal={makeGoal()} onClose={() => {}} />);

    const cronInput = await screen.findByPlaceholderText('@daily or 0 9 * * 1');
    fireEvent.input(cronInput, { target: { value: '@hourly' } });

    resolveFetch({ id: 'schedule-1', cronExpression: '0 9 * * 1', timezone: 'UTC' });
    await waitFor(() => expect((cronInput as HTMLInputElement).value).toBe('@hourly'));

    fireEvent.click(screen.getByRole('button', { name: 'Save Goal' }));

    await waitFor(() => expect(mockUpdateGoal).toHaveBeenCalled());
    expect(mockUpdateGoal).toHaveBeenCalledWith(
      'goal-1',
      expect.objectContaining({ checkInCronExpression: '@hourly' })
    );
  });

  it('preserves a timezone edit before fetch while still pre-filling the cron', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    mockGetSchedule.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    render(<SpaceGoalDialog isOpen goal={makeGoal()} onClose={() => {}} />);
    await waitFor(() => expect(mockGetSchedule).toHaveBeenCalledTimes(1));

    const timezoneSelect = screen
      .getAllByRole('combobox')
      .find((el) => (el as HTMLSelectElement).value === 'UTC') as HTMLSelectElement;
    timezoneSelect.value = 'Asia/Tokyo';
    timezoneSelect.dispatchEvent(new Event('change', { bubbles: true }));

    resolveFetch({ id: 'schedule-1', cronExpression: '0 9 * * 1', timezone: 'UTC' });
    await waitFor(() =>
      expect((screen.getByPlaceholderText('@daily or 0 9 * * 1') as HTMLInputElement).value).toBe(
        '0 9 * * 1'
      )
    );
    await waitFor(() => expect(timezoneSelect.value).toBe('Asia/Tokyo'));

    fireEvent.click(screen.getByRole('button', { name: 'Save Goal' }));

    await waitFor(() => expect(mockUpdateGoal).toHaveBeenCalled());
    const [, params] = mockUpdateGoal.mock.calls[0];
    expect(params).toEqual(expect.objectContaining({ checkInTimezone: 'Asia/Tokyo' }));
    expect(params).not.toHaveProperty('checkInCronExpression');
  });

  it('records the fetched cron even when cleared before fetch, so the schedule is removed', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    mockGetSchedule.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    render(<SpaceGoalDialog isOpen goal={makeGoal()} onClose={() => {}} />);
    await waitFor(() => expect(mockGetSchedule).toHaveBeenCalledTimes(1));

    const cronInput = screen.getByPlaceholderText('@daily or 0 9 * * 1') as HTMLInputElement;
    fireEvent.input(cronInput, '');

    resolveFetch({ id: 'schedule-1', cronExpression: '0 9 * * 1', timezone: 'UTC' });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal' }));

    await waitFor(() => expect(mockUpdateGoal).toHaveBeenCalled());
    expect(mockUpdateGoal).toHaveBeenCalledWith(
      'goal-1',
      expect.objectContaining({ checkInCronExpression: null })
    );
  });

  it('disables Save while the schedule prefill is loading, then enables it', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    mockGetSchedule.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    render(<SpaceGoalDialog isOpen goal={makeGoal()} onClose={() => {}} />);

    const saveButton = (await screen.findByRole('button', {
      name: 'Save Goal',
    })) as HTMLButtonElement;
    await waitFor(() => expect(saveButton.disabled).toBe(true));

    resolveFetch({ id: 'schedule-1', cronExpression: '0 9 * * 1', timezone: 'UTC' });
    await waitFor(() => expect(saveButton.disabled).toBe(false));
  });

  it('keeps Save disabled and surfaces an error when the schedule prefill fails', async () => {
    mockGetSchedule.mockRejectedValue(new Error('Network'));

    render(<SpaceGoalDialog isOpen goal={makeGoal()} onClose={() => {}} />);

    const saveButton = (await screen.findByRole('button', {
      name: 'Save Goal',
    })) as HTMLButtonElement;
    await waitFor(() => expect(saveButton.disabled).toBe(true));
    expect(await screen.findByText(/Could not load the check-in schedule/)).toBeTruthy();
  });

  it('renders a fetched non-common timezone as the selected option', async () => {
    mockGetSchedule.mockResolvedValue({
      id: 'schedule-1',
      cronExpression: '0 9 * * 1',
      timezone: 'America/Denver',
    });

    render(<SpaceGoalDialog isOpen goal={makeGoal()} onClose={() => {}} />);

    const select = (await screen.findByDisplayValue('America/Denver')) as HTMLSelectElement;
    expect(select.value).toBe('America/Denver');
  });
});
