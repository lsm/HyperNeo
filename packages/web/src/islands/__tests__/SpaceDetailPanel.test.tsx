import type { Space, SpaceTask } from '@hyperneo/shared';
import { type Signal, signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockNavigateToSpace,
  mockNavigateToSpaceAgent,
  mockNavigateToSpaceTask,
  mockNavigateToSpaceSession,
  mockNavigateToSpaceSessions,
  mockNavigateToSpaceGoals,
  mockNavigateToSpaceTasks,
} = vi.hoisted(() => ({
  mockNavigateToSpace: vi.fn(),
  mockNavigateToSpaceAgent: vi.fn(),
  mockNavigateToSpaceTask: vi.fn(),
  mockNavigateToSpaceSession: vi.fn(),
  mockNavigateToSpaceSessions: vi.fn(),
  mockNavigateToSpaceGoals: vi.fn(),
  mockNavigateToSpaceTasks: vi.fn(),
}));

const { mockArchiveSession, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockArchiveSession: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

let mockTasksSignal!: Signal<SpaceTask[]>;
let mockSpaceSignal!: Signal<Space | null>;
let mockLoadingSignal!: Signal<boolean>;
let mockSpaceIdSignal!: Signal<string | null>;
let mockSessionsSignal!: Signal<
  Array<{
    id: string;
    title: string;
    status: string;
    lastActiveAt: number;
    parentSessionId?: string | null;
    returnedAt?: string | null;
  }>
>;
let mockAgentsSignal!: Signal<unknown[]>;
const mockEnsureConfigData = vi.fn(() => Promise.resolve());
const mockSpawnAgentClone = vi.fn(() => Promise.resolve('clone-new'));
let mockGoalsSignal!: Signal<[]>;
let mockActiveRunsSignal!: Signal<Array<{ id: string }>>;
let mockCurrentSpaceSessionIdSignal!: Signal<string | null>;
let mockCurrentSpaceAgentHandleSignal!: Signal<string | null>;
let mockCurrentSpaceTaskIdSignal!: Signal<string | null>;
let mockCurrentSpaceViewModeSignal!: Signal<string>;
let mockSpaceOverlaySessionIdSignal!: Signal<string | null>;
let mockSpaceOverlayAgentNameSignal!: Signal<string | null>;

function initSignals() {
  mockTasksSignal = signal([]);
  mockSpaceSignal = signal(null);
  mockLoadingSignal = signal(false);
  mockSpaceIdSignal = signal('space-1');
  mockSessionsSignal = signal([]);
  mockAgentsSignal = signal([]);
  mockGoalsSignal = signal([]);
  mockActiveRunsSignal = signal([]);
  mockCurrentSpaceSessionIdSignal = signal(null);
  mockCurrentSpaceAgentHandleSignal = signal(null);
  mockCurrentSpaceTaskIdSignal = signal(null);
  mockCurrentSpaceViewModeSignal = signal('overview');
  mockSpaceOverlaySessionIdSignal = signal(null);
  mockSpaceOverlayAgentNameSignal = signal(null);
}

initSignals();

vi.mock('../../lib/space-store.ts', () => ({
  get spaceStore() {
    return {
      tasks: mockTasksSignal,
      space: mockSpaceSignal,
      loading: mockLoadingSignal,
      spaceId: mockSpaceIdSignal,
      sessions: mockSessionsSignal,
      agents: mockAgentsSignal,
      ensureConfigData: mockEnsureConfigData,
      spawnAgentClone: mockSpawnAgentClone,
      goals: mockGoalsSignal,
      activeRuns: mockActiveRunsSignal,
    };
  },
}));

vi.mock('../../lib/router.ts', () => ({
  navigateToSpace: mockNavigateToSpace,
  navigateToSpaceAgent: mockNavigateToSpaceAgent,
  navigateToSpaceTask: mockNavigateToSpaceTask,
  navigateToSpaceSession: mockNavigateToSpaceSession,
  navigateToSpaceSessions: mockNavigateToSpaceSessions,
  navigateToSpaceGoals: mockNavigateToSpaceGoals,
  navigateToSpaceTasks: mockNavigateToSpaceTasks,
}));

vi.mock('../../lib/signals.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/signals.ts')>();
  return {
    ...actual,
    get currentSpaceSessionIdSignal() {
      return mockCurrentSpaceSessionIdSignal;
    },
    get currentSpaceAgentHandleSignal() {
      return mockCurrentSpaceAgentHandleSignal;
    },
    get currentSpaceTaskIdSignal() {
      return mockCurrentSpaceTaskIdSignal;
    },
    get currentSpaceViewModeSignal() {
      return mockCurrentSpaceViewModeSignal;
    },
    get spaceOverlaySessionIdSignal() {
      return mockSpaceOverlaySessionIdSignal;
    },
    get spaceOverlayAgentNameSignal() {
      return mockSpaceOverlayAgentNameSignal;
    },
  };
});

vi.mock('../../lib/api-helpers.ts', () => ({
  createSession: vi.fn(),
  archiveSession: mockArchiveSession,
}));

vi.mock('../../lib/toast.ts', () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

import { SpaceDetailPanel } from '../SpaceDetailPanel';

function makeTask(
  id: string,
  title: string,
  status: SpaceTask['status'] = 'open',
  overrides: Partial<SpaceTask> = {}
): SpaceTask {
  return {
    id,
    spaceId: 'space-1',
    taskNumber: 1,
    title,
    description: '',
    status,
    priority: 'normal',
    labels: [],
    dependsOn: [],
    result: null,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as SpaceTask;
}

function makeSpace(id: string, overrides: Partial<Space> = {}): Space {
  return {
    id,
    name: `Space ${id}`,
    status: 'active',
    workspacePath: '/workspace',
    sessionIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as Space;
}

function getTaskTab(label: string): HTMLButtonElement {
  return screen.getByText(label).closest('button') as HTMLButtonElement;
}

describe('SpaceDetailPanel', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    initSignals();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows loading state when spaceStore is loading', () => {
    mockLoadingSignal.value = true;
    render(<SpaceDetailPanel spaceId="space-1" />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText('Overview')).toBeNull();
  });

  it('shows loading state when store spaceId does not match prop', () => {
    mockSpaceIdSignal.value = 'other-space';
    render(<SpaceDetailPanel spaceId="space-1" />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('renders Overview and Agents buttons', () => {
    render(<SpaceDetailPanel spaceId="space-1" />);
    expect(screen.getByText('Overview')).toBeTruthy();
    expect(screen.getByTestId('space-detail-agent')).toBeTruthy();
  });

  it('removes the old Space Activity header block', () => {
    mockSpaceSignal.value = makeSpace('space-1', { workspacePath: '/tmp/workspace' });
    render(<SpaceDetailPanel spaceId="space-1" />);
    expect(screen.queryByText('Space Activity')).toBeNull();
    expect(screen.queryByText('/tmp/workspace')).toBeNull();
  });

  it('navigates to space overview and calls onNavigate', () => {
    const onNavigate = vi.fn();
    render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText('Overview'));
    expect(mockNavigateToSpace).toHaveBeenCalledWith('space-1');
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it('uses the route space id for sidebar navigation', () => {
    render(<SpaceDetailPanel spaceId="space-1" navigationSpaceId="space-slug" />);
    fireEvent.click(screen.getByText('Overview'));
    fireEvent.click(screen.getByTestId('space-detail-agent'));

    expect(mockNavigateToSpace).toHaveBeenCalledWith('space-slug');
    expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('space-slug');
  });

  it('navigates to the space agent and calls onNavigate', () => {
    const onNavigate = vi.fn();
    render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByTestId('space-detail-agent'));
    expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('space-1');
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it('highlights Overview when neither session nor task is selected', () => {
    render(<SpaceDetailPanel spaceId="space-1" />);
    const button = screen.getByText('Overview').closest('button');
    expect(button?.className).toContain('bg-fill');
  });

  it('highlights Agents when the agents view mode is active', () => {
    mockCurrentSpaceViewModeSignal.value = 'agents';
    render(<SpaceDetailPanel spaceId="space-1" />);
    const button = screen.getByTestId('space-detail-agent').closest('button');
    expect(button?.className).toContain('bg-fill');
  });

  it('shows Action tasks by default and includes counters on task tabs', () => {
    mockTasksSignal.value = [
      makeTask('t1', 'Queued Task', 'open'),
      makeTask('t2', 'In Progress Task', 'in_progress'),
      makeTask('t3', 'Blocked Task', 'blocked'),
    ];
    render(<SpaceDetailPanel spaceId="space-1" />);

    expect(screen.getByText('Blocked Task')).toBeTruthy();
    expect(screen.queryByText('Queued Task')).toBeNull();

    const activeTab = getTaskTab('Active');
    const actionTab = getTaskTab('Action');
    expect(within(activeTab).getByText('2')).toBeTruthy();
    expect(within(actionTab).getByText('1')).toBeTruthy();
  });

  it('switches to Active tasks when the Active tab is clicked', () => {
    mockTasksSignal.value = [
      makeTask('t1', 'Queued Task', 'open'),
      makeTask('t2', 'Blocked Task', 'blocked'),
    ];
    render(<SpaceDetailPanel spaceId="space-1" />);

    fireEvent.click(getTaskTab('Active'));
    expect(screen.getByText('Queued Task')).toBeTruthy();
    expect(screen.queryByText('Blocked Task')).toBeNull();
  });

  it('orders running tasks before open ones in the Active tab (recency as tiebreaker)', () => {
    mockTasksSignal.value = [
      makeTask('t-open', 'Open Recent', 'open', { updatedAt: 300 }),
      makeTask('t-prog', 'In Progress Older', 'in_progress', { updatedAt: 100 }),
      makeTask('t-appr', 'Approved Mid', 'approved', { updatedAt: 200 }),
    ];
    render(<SpaceDetailPanel spaceId="space-1" />);
    fireEvent.click(getTaskTab('Active'));

    const prog = screen.getByText('In Progress Older');
    const appr = screen.getByText('Approved Mid');
    const openEl = screen.getByText('Open Recent');
    const follows = Node.DOCUMENT_POSITION_FOLLOWING;

    expect(prog.compareDocumentPosition(appr) & follows).toBeTruthy();
    expect(appr.compareDocumentPosition(openEl) & follows).toBeTruthy();
  });

  it('does not show a terminal (done) task in the active or action tab', () => {
    mockTasksSignal.value = [
      makeTask('t1', 'Queued Task', 'open'),
      makeTask('t2', 'Done Task', 'done'),
    ];
    mockCurrentSpaceTaskIdSignal.value = 't2';
    render(<SpaceDetailPanel spaceId="space-1" />);

    expect(screen.queryByText('Done Task')).toBeNull();
  });

  it('navigates to a task on click and calls onNavigate', () => {
    const onNavigate = vi.fn();
    mockTasksSignal.value = [makeTask('t1', 'Blocked Task', 'blocked')];
    render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText('Blocked Task'));
    expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('space-1', 't1');
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it('lists the Space agents instead of sessions', () => {
    mockSessionsSignal.value = [
      { id: 'manual-session-abc123', title: 'manual-s', status: 'active', lastActiveAt: 0 },
    ];
    mockAgentsSignal.value = [
      { id: 'a1', handle: 'lead', displayName: 'Lead', status: 'active', sessionId: 'sess-a1' },
      { id: 'a2', handle: 'old', displayName: 'Old', status: 'archived', sessionId: null },
    ];
    render(<SpaceDetailPanel spaceId="space-1" />);

    expect(screen.getAllByText('Agents')).toHaveLength(2);
    expect(screen.getByText('Lead')).toBeTruthy();
    expect(screen.queryByText('Old')).toBeNull();
    expect(screen.queryByText('manual-s')).toBeNull();
  });

  it('opens the agent route on click and calls onNavigate', () => {
    const onNavigate = vi.fn();
    mockAgentsSignal.value = [
      { id: 'a1', handle: 'lead', displayName: 'Lead', status: 'active', sessionId: 'sess-a1' },
    ];
    render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText('Lead'));
    expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('space-1', 'lead');
    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it('highlights the agent row for the agent route', () => {
    mockAgentsSignal.value = [
      { id: 'a1', handle: 'lead', displayName: 'Lead', status: 'active', sessionId: 'sess-a1' },
    ];
    mockCurrentSpaceAgentHandleSignal.value = 'lead';
    render(<SpaceDetailPanel spaceId="space-1" />);

    expect(screen.getByTestId('space-detail-agent-row').parentElement?.className).toContain(
      'bg-fill-soft'
    );
  });

  it('nests clones under their agent, marks returned ones, and opens them on click', () => {
    const onNavigate = vi.fn();
    mockAgentsSignal.value = [
      { id: 'a1', handle: 'lead', displayName: 'Lead', status: 'active', sessionId: 'sess-a1' },
    ];
    mockSessionsSignal.value = [
      { id: 'sess-a1', title: 'Lead', status: 'active', lastActiveAt: 5 },
      {
        id: 'clone-1',
        title: 'Lead · 分身',
        status: 'active',
        lastActiveAt: 3,
        parentSessionId: 'sess-a1',
        returnedAt: '2026-09-24T00:00:00.000Z',
      },
      {
        id: 'clone-2',
        title: 'Lead · 分身 2',
        status: 'active',
        lastActiveAt: 4,
        parentSessionId: 'sess-a1',
        returnedAt: null,
      },
      { id: 'stray', title: 'Stray', status: 'active', lastActiveAt: 9, parentSessionId: 'gone' },
    ];
    mockCurrentSpaceSessionIdSignal.value = 'clone-2';
    render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);

    const rows = screen.getAllByTestId('space-detail-clone-row');
    expect(rows.map((row) => row.textContent)).toEqual(['分身Lead · 分身 2', '分身Lead · 分身✓']);
    expect(rows[0].className).toContain('bg-fill-soft');
    expect(screen.queryByText('Stray')).toBeNull();

    fireEvent.click(rows[1]);
    expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'clone-1');
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it('spawns a new conversation from the agent row and opens it', async () => {
    const onNavigate = vi.fn();
    mockAgentsSignal.value = [
      { id: 'a1', handle: 'lead', displayName: 'Lead', status: 'active', sessionId: 'sess-a1' },
    ];
    render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByTestId('space-detail-agent-spawn'));
    expect(mockSpawnAgentClone).toHaveBeenCalledWith('a1');
    await waitFor(() =>
      expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'clone-new')
    );
    expect(mockNavigateToSpaceAgent).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it('loads the Space agents when the panel mounts', () => {
    render(<SpaceDetailPanel spaceId="space-1" />);
    expect(mockEnsureConfigData).toHaveBeenCalled();
  });

  it('opens the agent page for an agent that has no session yet', () => {
    mockAgentsSignal.value = [
      { id: 'a2', handle: 'fresh', displayName: 'Fresh', status: 'active', sessionId: null },
    ];
    render(<SpaceDetailPanel spaceId="space-1" />);

    fireEvent.click(screen.getByText('Fresh'));
    expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('space-1', 'fresh');
    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
  });

  describe('task visibility in context panel', () => {
    it('shows all tasks matching the active tab filter', () => {
      mockTasksSignal.value = [
        makeTask('t1', 'Open Task', 'open'),
        makeTask('t2', 'In Progress Task', 'in_progress'),
        makeTask('t3', 'Blocked Task', 'blocked'),
        makeTask('t4', 'Done Task', 'done'),
      ];
      render(<SpaceDetailPanel spaceId="space-1" />);

      expect(screen.getByText('Blocked Task')).toBeTruthy();
      expect(screen.queryByText('Open Task')).toBeNull();
      expect(screen.queryByText('In Progress Task')).toBeNull();
      expect(screen.queryByText('Done Task')).toBeNull();

      fireEvent.click(getTaskTab('Active'));
      expect(screen.getByText('Open Task')).toBeTruthy();
      expect(screen.getByText('In Progress Task')).toBeTruthy();
      expect(screen.queryByText('Blocked Task')).toBeNull();
    });

    it('tasks appear without manual refresh when signal updates', () => {
      mockTasksSignal.value = [];
      const { rerender } = render(<SpaceDetailPanel spaceId="space-1" />);

      expect(screen.getByText('No tasks')).toBeTruthy();

      mockTasksSignal.value = [makeTask('t-new', 'New Task', 'blocked')];
      rerender(<SpaceDetailPanel spaceId="space-1" />);

      expect(screen.getByText('New Task')).toBeTruthy();
      expect(screen.queryByText('No tasks')).toBeNull();
    });

    it('count badges update when new tasks arrive', () => {
      mockTasksSignal.value = [makeTask('t1', 'Task A', 'open')];
      const { rerender } = render(<SpaceDetailPanel spaceId="space-1" />);

      expect(screen.getByText('1')).toBeTruthy();
      expect(screen.getByText('0')).toBeTruthy();

      mockTasksSignal.value = [
        makeTask('t1', 'Task A', 'open'),
        makeTask('t2', 'Task B', 'blocked'),
      ];
      rerender(<SpaceDetailPanel spaceId="space-1" />);

      const badges = screen.getAllByText('1');
      expect(badges.length).toBe(3);
    });

    it('task status change updates tab counts and visibility', () => {
      mockTasksSignal.value = [
        makeTask('t1', 'Task One', 'in_progress'),
        makeTask('t2', 'Task Two', 'blocked'),
      ];
      const { rerender } = render(<SpaceDetailPanel spaceId="space-1" />);

      expect(screen.getByText('Task Two')).toBeTruthy();

      mockTasksSignal.value = [
        makeTask('t1', 'Task One', 'blocked'),
        makeTask('t2', 'Task Two', 'done'),
      ];
      rerender(<SpaceDetailPanel spaceId="space-1" />);

      expect(screen.getByText('Task One')).toBeTruthy();
      expect(screen.queryByText('Task Two')).toBeNull();
    });

    it('Tasks-nav badge counts blocked tasks even when no review tasks exist', () => {
      mockTasksSignal.value = [
        makeTask('t1', 'Blocked One', 'blocked'),
        makeTask('t2', 'Blocked Two', 'blocked'),
      ];
      render(<SpaceDetailPanel spaceId="space-1" />);

      const tasksNav = screen.getByTestId('space-detail-tasks');
      expect(tasksNav).toBeTruthy();
      expect(within(tasksNav).getByText('2')).toBeTruthy();
    });

    it('Tasks-nav badge stays in sync with the Action tab count', () => {
      mockTasksSignal.value = [
        makeTask('t1', 'Blocked Task', 'blocked'),
        makeTask('t2', 'Review Task', 'review'),
        makeTask('t3', 'Open Task', 'open'),
      ];
      render(<SpaceDetailPanel spaceId="space-1" />);

      const actionTabButton = screen.getByRole('button', { name: /Action/i });
      expect(within(actionTabButton).getByText('2')).toBeTruthy();

      const tasksNav = screen.getByTestId('space-detail-tasks');
      expect(within(tasksNav).getByText('2')).toBeTruthy();
    });

    it('Tasks-nav badge is hidden when no action-required tasks exist', () => {
      mockTasksSignal.value = [
        makeTask('t1', 'Open Task', 'open'),
        makeTask('t2', 'In Progress Task', 'in_progress'),
        makeTask('t3', 'Done Task', 'done'),
      ];
      render(<SpaceDetailPanel spaceId="space-1" />);

      const tasksNav = screen.getByTestId('space-detail-tasks');
      expect(tasksNav).toBeTruthy();
      expect(within(tasksNav).queryByText('2')).toBeNull();
      expect(within(tasksNav).queryByText('1')).toBeNull();
    });

    it('shows approved (post-approval running) tasks under the Active tab', () => {
      mockTasksSignal.value = [
        makeTask('t1', 'Approved Task', 'approved'),
        makeTask('t2', 'Open Task', 'open'),
        makeTask('t3', 'Blocked Task', 'blocked'),
      ];
      render(<SpaceDetailPanel spaceId="space-1" />);

      fireEvent.click(getTaskTab('Active'));
      expect(screen.getByText('Approved Task')).toBeTruthy();
      expect(screen.getByText('Open Task')).toBeTruthy();
      expect(screen.queryByText('Blocked Task')).toBeNull();

      const activeTab = getTaskTab('Active');
      expect(within(activeTab).getByText('2')).toBeTruthy();
    });

    it('multiple tasks created via different paths all appear in panel', () => {
      mockTasksSignal.value = [
        makeTask('t-ui', 'UI Dialog Task', 'open'),
        makeTask('t-agent', 'Agent Created Task', 'in_progress', {
          workflowRunId: 'run-1',
        }),
        makeTask('t-workflow', 'Workflow Task', 'in_progress', {
          workflowRunId: 'run-1',
        }),
      ];
      render(<SpaceDetailPanel spaceId="space-1" />);

      fireEvent.click(getTaskTab('Active'));

      expect(screen.getByText('UI Dialog Task')).toBeTruthy();
      expect(screen.getByText('Agent Created Task')).toBeTruthy();
      expect(screen.getByText('Workflow Task')).toBeTruthy();
    });
  });

  describe('sidebar list caps and View all links', () => {
    function makeTasks(count: number, status: SpaceTask['status'] = 'blocked') {
      return Array.from({ length: count }, (_, i) =>
        makeTask(`t${i}`, `Task ${String(i)}`, status, { updatedAt: i })
      );
    }

    it('renders exactly LIMIT tasks with no View all button', () => {
      mockTasksSignal.value = makeTasks(10);
      render(<SpaceDetailPanel spaceId="space-1" />);
      expect(screen.getByText('Task 0')).toBeTruthy();
      expect(screen.getByText('Task 9')).toBeTruthy();
      expect(screen.queryByTestId('space-tasks-view-all')).toBeNull();
    });

    it('caps tasks at LIMIT and shows a View all button with the full tab count', () => {
      mockTasksSignal.value = makeTasks(12);
      render(<SpaceDetailPanel spaceId="space-1" />);
      expect(screen.queryByText('Task 0')).toBeNull();
      expect(screen.queryByText('Task 1')).toBeNull();
      expect(screen.getByText('Task 2')).toBeTruthy();
      const btn = screen.getByTestId('space-tasks-view-all');
      expect(btn.textContent).toContain('12');
    });

    it('keeps a selected task that falls past the cap visible', () => {
      mockTasksSignal.value = makeTasks(12);
      mockCurrentSpaceTaskIdSignal.value = 't0';
      render(<SpaceDetailPanel spaceId="space-1" />);
      expect(screen.getByText('Task 0')).toBeTruthy();
      expect(screen.queryByText('Task 1')).toBeNull();
    });

    it('View all tasks navigates preserving the active tab', () => {
      mockTasksSignal.value = makeTasks(12, 'open');
      render(<SpaceDetailPanel spaceId="space-1" />);
      fireEvent.click(getTaskTab('Active'));
      fireEvent.click(screen.getByTestId('space-tasks-view-all'));
      expect(mockNavigateToSpaceTasks).toHaveBeenCalledWith('space-1', 'active');
    });

    it('Tasks nav button still uses the derived default tab', () => {
      mockTasksSignal.value = [makeTask('t1', 'Open Task', 'open')];
      render(<SpaceDetailPanel spaceId="space-1" />);
      fireEvent.click(screen.getByTestId('space-detail-tasks'));
      expect(mockNavigateToSpaceTasks).toHaveBeenCalledWith('space-1', 'active');
    });
  });
});
