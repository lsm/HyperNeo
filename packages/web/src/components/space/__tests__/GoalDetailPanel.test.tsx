import type {
  SpaceGoal,
  SpaceGoalOwnerResolution,
  SpaceLongHorizonAgent,
  SpaceTask,
} from '@hyperneo/shared';
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

import { connectionState } from '../../../lib/state';
import { spaceStore } from '../../../lib/space-store';
import { GoalDetailPanel } from '../GoalDetailPanel';

const mockSpaceId = signal<string | null>('space-1');
const mockGoals = signal<SpaceGoal[]>([]);
const mockTasks = signal<SpaceTask[]>([]);
const mockWorkflows = signal<unknown[]>([]);
const mockGoalOwners = signal<Map<string, SpaceGoalOwnerResolution>>(new Map());
const mockLongHorizonAgents = signal<SpaceLongHorizonAgent[]>([]);
const mockPauseGoal = vi.fn();
const mockResumeGoal = vi.fn();
const mockArchiveGoal = vi.fn();
const mockCreateImmediateGoalTask = vi.fn();
const mockUpdateGoal = vi.fn();
const mockGetSchedule = vi.fn();
const mockFetchGoalOwner = vi.fn();
const mockAssignGoalOwner = vi.fn();
const mockUnassignGoalOwner = vi.fn();
const mockRefreshLongHorizonAgents = vi.fn(async () => {});
const mockUpsertGoal = vi.fn((goal: SpaceGoal) => {
  mockGoals.value = [goal, ...mockGoals.value.filter((current) => current.id !== goal.id)];
});

const mutableSpaceStore = spaceStore as unknown as {
  spaceId: Signal<string | null>;
  goals: Signal<SpaceGoal[]>;
  tasks: Signal<SpaceTask[]>;
  workflows: Signal<unknown[]>;
  goalOwners: Signal<Map<string, SpaceGoalOwnerResolution>>;
  longHorizonAgents: Signal<SpaceLongHorizonAgent[]>;
  pauseGoal: typeof mockPauseGoal;
  resumeGoal: typeof mockResumeGoal;
  archiveGoal: typeof mockArchiveGoal;
  createImmediateGoalTask: typeof mockCreateImmediateGoalTask;
  updateGoal: typeof mockUpdateGoal;
  getSchedule: typeof mockGetSchedule;
  fetchGoalOwner: typeof mockFetchGoalOwner;
  assignGoalOwner: typeof mockAssignGoalOwner;
  unassignGoalOwner: typeof mockUnassignGoalOwner;
  refreshLongHorizonAgents: typeof mockRefreshLongHorizonAgents;
  upsertGoal: typeof mockUpsertGoal;
};

mutableSpaceStore.spaceId = mockSpaceId;
mutableSpaceStore.goals = mockGoals;
mutableSpaceStore.tasks = mockTasks;
mutableSpaceStore.workflows = mockWorkflows;
mutableSpaceStore.goalOwners = mockGoalOwners;
mutableSpaceStore.longHorizonAgents = mockLongHorizonAgents;
mutableSpaceStore.pauseGoal = mockPauseGoal;
mutableSpaceStore.resumeGoal = mockResumeGoal;
mutableSpaceStore.archiveGoal = mockArchiveGoal;
mutableSpaceStore.createImmediateGoalTask = mockCreateImmediateGoalTask;
mutableSpaceStore.updateGoal = mockUpdateGoal;
mutableSpaceStore.getSchedule = mockGetSchedule;
mutableSpaceStore.fetchGoalOwner = mockFetchGoalOwner;
mutableSpaceStore.assignGoalOwner = mockAssignGoalOwner;
mutableSpaceStore.unassignGoalOwner = mockUnassignGoalOwner;
mutableSpaceStore.refreshLongHorizonAgents = mockRefreshLongHorizonAgents;
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

async function chooseAssignee(value: string): Promise<void> {
  const combo = screen.getByRole('combobox', { name: 'New goal owner' }) as HTMLSelectElement;
  combo.value = value;
  combo.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Assign' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  );
}

function formatGoalDate(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function makeAgent(overrides: Partial<SpaceLongHorizonAgent> = {}): SpaceLongHorizonAgent {
  return {
    id: 'agent-1',
    spaceId: 'space-1',
    handle: 'scout',
    displayName: 'Scout',
    templateKey: null,
    status: 'active',
    sessionId: null,
    instructions: '',
    autonomyLevel: null,
    model: null,
    thinkingLevel: null,
    provider: null,
    settingSources: null,
    toolPermissions: {},
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function resolvedOwner(
  agentId = 'agent-1',
  conflicts: Array<{ agentId: string; relationship: 'owner'; createdAt: number }> = []
): SpaceGoalOwnerResolution {
  return {
    action: 'resolved',
    owner: { agentId, relationship: 'owner', createdAt: Date.now() - 30_000 },
    conflicts,
  };
}

describe('GoalDetailPanel', () => {
  beforeEach(() => {
    connectionState.value = 'connected';
    mockSpaceId.value = 'space-1';
    mockGoals.value = [makeGoal()];
    mockTasks.value = [makeTask()];
    mockWorkflows.value = [];
    mockGoalOwners.value = new Map();
    mockLongHorizonAgents.value = [makeAgent()];
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
    mockFetchGoalOwner.mockImplementation(async (goalId: string) => {
      const owner = resolvedOwner();
      mockGoalOwners.value = new Map(mockGoalOwners.value).set(goalId, owner);
      return owner;
    });
    mockAssignGoalOwner.mockImplementation(async (goalId: string, agentId: string) => {
      const owner = resolvedOwner(agentId);
      mockGoalOwners.value = new Map(mockGoalOwners.value).set(goalId, owner);
      return owner;
    });
    mockUnassignGoalOwner.mockImplementation(async (goalId: string) => {
      const owner: SpaceGoalOwnerResolution = { action: 'no_recipient' };
      mockGoalOwners.value = new Map(mockGoalOwners.value).set(goalId, owner);
      return owner;
    });
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

  it('shows a loading state while the owner resolves', () => {
    mockFetchGoalOwner.mockImplementation(() => new Promise(() => {}));
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    expect(screen.getByText('Loading owner…')).toBeTruthy();
    expect(mockFetchGoalOwner).toHaveBeenCalledWith('goal-1');
  });

  it('shows the resolved owner with change and unassign controls', async () => {
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    await waitFor(() => expect(screen.getByText('Scout (@scout)')).toBeTruthy());
    expect(screen.getByText('Owned')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change owner' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unassign' })).toBeTruthy();
  });

  it('shows the degraded state with the owner failure reason', async () => {
    mockFetchGoalOwner.mockImplementation(async (goalId: string) => {
      const owner: SpaceGoalOwnerResolution = {
        action: 'degraded',
        reason: 'paused',
        owner: { agentId: 'agent-1', relationship: 'owner', createdAt: Date.now() },
        conflicts: [],
      };
      mockGoalOwners.value = new Map(mockGoalOwners.value).set(goalId, owner);
      return owner;
    });
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    await waitFor(() => expect(screen.getByText('Degraded')).toBeTruthy());
    expect(screen.getByText(/Owner is paused/)).toBeTruthy();
  });

  it('shows the unowned state for no-recipient and coordinator fallback', async () => {
    mockFetchGoalOwner.mockImplementation(async (goalId: string) => {
      const owner: SpaceGoalOwnerResolution = { action: 'no_recipient' };
      mockGoalOwners.value = new Map(mockGoalOwners.value).set(goalId, owner);
      return owner;
    });
    const { unmount } = render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);
    await waitFor(() =>
      expect(screen.getByText('No long-horizon agent owns this goal.')).toBeTruthy()
    );
    unmount();

    mockFetchGoalOwner.mockImplementation(async (goalId: string) => {
      const owner: SpaceGoalOwnerResolution = {
        action: 'coordinator_fallback',
        coordinatorAgentId: 'agent-1',
      };
      mockGoalOwners.value = new Map(mockGoalOwners.value).set(goalId, owner);
      return owner;
    });
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);
    await waitFor(() =>
      expect(screen.getByText('Falls back to coordinator Scout (@scout)')).toBeTruthy()
    );
  });

  it('assigns a new owner from the picker and reports the fresh owner', async () => {
    mockLongHorizonAgents.value = [
      makeAgent(),
      makeAgent({ id: 'agent-2', handle: 'watchman', displayName: 'Watchman' }),
    ];
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Change owner' }));
    await chooseAssignee('agent-2');
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));

    await waitFor(() => expect(mockAssignGoalOwner).toHaveBeenCalledWith('goal-1', 'agent-2'));
    expect(mockToastSuccess).toHaveBeenCalledWith('Owner updated — previous owner superseded');
    await waitFor(() => expect(screen.getByText('Watchman (@watchman)')).toBeTruthy());
  });

  it('reports the replaced owner from the pre-assignment state on reassignment', async () => {
    mockLongHorizonAgents.value = [
      makeAgent(),
      makeAgent({ id: 'agent-2', handle: 'watchman', displayName: 'Watchman' }),
    ];
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Change owner' }));
    await chooseAssignee('agent-2');
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith('Owner updated — previous owner superseded')
    );
  });

  it('keeps the assign picker open across agent status changes', async () => {
    mockLongHorizonAgents.value = [
      makeAgent(),
      makeAgent({ id: 'agent-2', handle: 'watchman', displayName: 'Watchman' }),
    ];
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Change owner' }));
    await chooseAssignee('agent-2');
    expect(screen.getByRole('combobox', { name: 'New goal owner' })).toBeTruthy();

    mockFetchGoalOwner.mockImplementation(async (goalId: string) => {
      const owner: SpaceGoalOwnerResolution = {
        action: 'degraded',
        reason: 'paused',
        owner: { agentId: 'agent-1', relationship: 'owner', createdAt: Date.now() },
        conflicts: [],
      };
      mockGoalOwners.value = new Map(mockGoalOwners.value).set(goalId, owner);
      return owner;
    });
    mockLongHorizonAgents.value = [
      makeAgent({ status: 'paused' }),
      makeAgent({ id: 'agent-2', handle: 'watchman', displayName: 'Watchman' }),
    ];

    await waitFor(() => expect(screen.getByText('Degraded')).toBeTruthy());
    expect(screen.getByRole('combobox', { name: 'New goal owner' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Assign' }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it('clears the owner error banner after a successful assignment', async () => {
    mockLongHorizonAgents.value = [
      makeAgent(),
      makeAgent({ id: 'agent-2', handle: 'watchman', displayName: 'Watchman' }),
    ];
    mockFetchGoalOwner.mockRejectedValue(new Error('Not connected'));
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    await waitFor(() =>
      expect(screen.getByText('Owner unavailable — refresh to retry.')).toBeTruthy()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Assign owner' }));
    await chooseAssignee('agent-2');
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));

    await waitFor(() =>
      expect(screen.queryByText('Owner unavailable — refresh to retry.')).toBeNull()
    );
    expect(screen.getByText('Watchman (@watchman)')).toBeTruthy();
  });

  it('refreshes the owner resolution when the owning agent changes status', async () => {
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);
    await waitFor(() => expect(screen.getByText('Owned')).toBeTruthy());

    mockFetchGoalOwner.mockImplementation(async (goalId: string) => {
      const owner: SpaceGoalOwnerResolution = {
        action: 'degraded',
        reason: 'paused',
        owner: { agentId: 'agent-1', relationship: 'owner', createdAt: Date.now() },
        conflicts: [],
      };
      mockGoalOwners.value = new Map(mockGoalOwners.value).set(goalId, owner);
      return owner;
    });
    mockLongHorizonAgents.value = [makeAgent({ status: 'paused' })];

    await waitFor(() => expect(screen.getByText('Degraded')).toBeTruthy());
    expect(mockFetchGoalOwner).toHaveBeenCalledTimes(2);
  });

  it('retries the owner request after the transport reconnects', async () => {
    connectionState.value = 'connecting';
    mockFetchGoalOwner.mockRejectedValueOnce(new Error('Not connected'));
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    await waitFor(() =>
      expect(screen.getByText('Owner unavailable — refresh to retry.')).toBeTruthy()
    );

    connectionState.value = 'connected';
    await waitFor(() => expect(screen.getByText('Scout (@scout)')).toBeTruthy());
    expect(screen.queryByText('Owner unavailable — refresh to retry.')).toBeNull();
  });

  it('surfaces assignment errors as a toast', async () => {
    mockLongHorizonAgents.value = [
      makeAgent(),
      makeAgent({ id: 'agent-2', handle: 'watchman', displayName: 'Watchman' }),
    ];
    mockAssignGoalOwner.mockRejectedValue(new Error('not coordinator or human'));
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Change owner' }));
    await chooseAssignee('agent-2');
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('not coordinator or human'));
  });

  it('unassigns the current owner', async () => {
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unassign' }));

    await waitFor(() => expect(mockUnassignGoalOwner).toHaveBeenCalledWith('goal-1'));
    expect(mockToastSuccess).toHaveBeenCalledWith('Owner cleared');
    await waitFor(() =>
      expect(screen.getByText('No long-horizon agent owns this goal.')).toBeTruthy()
    );
  });

  it('falls back to the raw agent id when the owner agent is no longer listed', async () => {
    mockLongHorizonAgents.value = [];
    mockFetchGoalOwner.mockImplementation(async (goalId: string) => {
      const owner = resolvedOwner('agent-gone');
      mockGoalOwners.value = new Map(mockGoalOwners.value).set(goalId, owner);
      return owner;
    });
    render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    await waitFor(() => expect(screen.getByText('agent-gone (not found)')).toBeTruthy());
  });

  it('ignores a stale owner-fetch rejection after switching goals', async () => {
    let rejectFirst: (err: Error) => void = () => {};
    mockFetchGoalOwner.mockImplementation((goalId: string) => {
      if (goalId === 'goal-1') {
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      const owner = resolvedOwner();
      mockGoalOwners.value = new Map(mockGoalOwners.value).set(goalId, owner);
      return Promise.resolve(owner);
    });
    mockGoals.value = [makeGoal(), makeGoal({ id: 'goal-2', title: 'Second goal' })];
    const { rerender } = render(<GoalDetailPanel spaceId="space-1" goalId="goal-1" />);

    rerender(<GoalDetailPanel spaceId="space-1" goalId="goal-2" />);
    await waitFor(() => expect(screen.getByText('Scout (@scout)')).toBeTruthy());

    rejectFirst(new Error('stale request failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText('Owner unavailable — refresh to retry.')).toBeNull();
    expect(screen.getByText('Scout (@scout)')).toBeTruthy();
  });
});
