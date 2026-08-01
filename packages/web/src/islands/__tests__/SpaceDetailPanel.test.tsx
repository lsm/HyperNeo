/**
 * Tests for SpaceDetailPanel.
 *
 * Covers overview/agent navigation, task tab defaults, counters, and sessions behavior.
 */

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
  Array<{ id: string; title: string; status: string; lastActiveAt: number }>
>;
let mockGoalsSignal!: Signal<[]>;
let mockActiveRunsSignal!: Signal<Array<{ id: string }>>;
let mockCurrentSpaceSessionIdSignal!: Signal<string | null>;
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
  mockGoalsSignal = signal([]);
  mockActiveRunsSignal = signal([]);
  mockCurrentSpaceSessionIdSignal = signal(null);
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
    expect(screen.getByText('Agents')).toBeTruthy();
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
    fireEvent.click(screen.getByText('Agents'));

    expect(mockNavigateToSpace).toHaveBeenCalledWith('space-slug');
    expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('space-slug');
  });

  it('navigates to the space agent and calls onNavigate', () => {
    const onNavigate = vi.fn();
    render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText('Agents'));
    expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('space-1');
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it('highlights Overview when neither session nor task is selected', () => {
    render(<SpaceDetailPanel spaceId="space-1" />);
    const button = screen.getByText('Overview').closest('button');
    expect(button?.className).toContain('bg-white/10');
  });

  it('highlights Agents when the agents view mode is active', () => {
    mockCurrentSpaceViewModeSignal.value = 'agents';
    render(<SpaceDetailPanel spaceId="space-1" />);
    const button = screen.getByText('Agents').closest('button');
    expect(button?.className).toContain('bg-white/10');
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

  it('does not show a terminal (done) task in the active or action tab', () => {
    mockTasksSignal.value = [
      makeTask('t1', 'Queued Task', 'open'),
      makeTask('t2', 'Done Task', 'done'),
    ];
    mockCurrentSpaceTaskIdSignal.value = 't2';
    render(<SpaceDetailPanel spaceId="space-1" />);

    // Done tasks belong to neither tab; selecting one should not make it appear in the list
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

  it('renders Sessions expanded by default', () => {
    mockSessionsSignal.value = [
      { id: 'manual-session-abc123', title: 'manual-s', status: 'active', lastActiveAt: 0 },
    ];
    render(<SpaceDetailPanel spaceId="space-1" />);
    expect(screen.getByText('manual-s')).toBeTruthy();
  });

  it('filters out system sessions from the Sessions section', () => {
    mockSessionsSignal.value = [
      {
        id: 'space:space-1:task:task-123',
        title: 'task-session',
        status: 'active',
        lastActiveAt: 0,
      },
      {
        id: 'space:space-1:workflow:run-1',
        title: 'workflow-session',
        status: 'active',
        lastActiveAt: 0,
      },
      { id: 'manual-session-abc123', title: 'manual-s', status: 'active', lastActiveAt: 0 },
    ];
    render(<SpaceDetailPanel spaceId="space-1" />);

    expect(screen.queryByText('task-session')).toBeNull();
    expect(screen.queryByText('workflow-session')).toBeNull();
    expect(screen.getByText('manual-s')).toBeTruthy();
  });

  it('opens overlay on session click and calls onNavigate', () => {
    const onNavigate = vi.fn();
    mockSpaceOverlaySessionIdSignal.value = null;
    mockSessionsSignal.value = [
      { id: 'manual-session-abc123', title: 'manual-s', status: 'active', lastActiveAt: 0 },
    ];
    render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText('manual-s'));
    expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'manual-session-abc123');
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  describe('session row actions', () => {
    beforeEach(() => {
      mockArchiveSession.mockReset();
      mockToastSuccess.mockReset();
      mockToastError.mockReset();
    });

    it('shows an archive action but no inline rename pencil on session rows', () => {
      mockSessionsSignal.value = [
        { id: 's1', title: 'session one', status: 'active', lastActiveAt: 0 },
      ];
      render(<SpaceDetailPanel spaceId="space-1" />);

      // Rename is via double-click only; the hover pencil was removed.
      expect(screen.queryByTestId('space-session-rename')).toBeNull();
      // Archive is the single hover action.
      expect(screen.getByTestId('space-session-archive')).toBeTruthy();
    });

    it('enters rename mode on double-click of a session title', () => {
      mockSessionsSignal.value = [
        { id: 's1', title: 'session one', status: 'active', lastActiveAt: 0 },
      ];
      const { container } = render(<SpaceDetailPanel spaceId="space-1" />);

      fireEvent.dblClick(screen.getByText('session one'));

      expect(
        container.querySelector('input[data-testid="space-session-rename-input"]')
      ).toBeTruthy();
    });

    it('archives a session after the inline confirmation click', async () => {
      mockArchiveSession.mockResolvedValue({ success: true, requiresConfirmation: false });
      mockSessionsSignal.value = [
        { id: 's1', title: 'session one', status: 'active', lastActiveAt: 0 },
      ];
      render(<SpaceDetailPanel spaceId="space-1" />);

      fireEvent.click(screen.getByTestId('space-session-archive'));
      fireEvent.click(screen.getByTestId('space-session-archive-confirm'));

      await waitFor(() => expect(mockArchiveSession).toHaveBeenCalledWith('s1', false));
      expect(mockToastSuccess).toHaveBeenCalledWith('Session archived');
    });

    it('opens the commit-loss confirm dialog when archive requires confirmation', async () => {
      mockArchiveSession.mockResolvedValue({
        success: false,
        requiresConfirmation: true,
        commitStatus: { hasCommitsAhead: true, commits: [], baseBranch: 'main' },
      });
      mockSessionsSignal.value = [
        { id: 's1', title: 'session one', status: 'active', lastActiveAt: 0 },
      ];
      render(<SpaceDetailPanel spaceId="space-1" />);

      fireEvent.click(screen.getByTestId('space-session-archive'));
      fireEvent.click(screen.getByTestId('space-session-archive-confirm'));

      await waitFor(() => expect(mockArchiveSession).toHaveBeenCalledWith('s1', false));
      // The commit-loss modal renders (ArchiveConfirmDialog heading).
      expect(screen.getByText('Confirm Archive')).toBeTruthy();
      expect(mockToastSuccess).not.toHaveBeenCalled();
    });
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

      // Default tab is "action" — shows blocked tasks
      expect(screen.getByText('Blocked Task')).toBeTruthy();
      expect(screen.queryByText('Open Task')).toBeNull();
      expect(screen.queryByText('In Progress Task')).toBeNull();
      expect(screen.queryByText('Done Task')).toBeNull();

      // Switch to Active — shows open + in_progress
      fireEvent.click(getTaskTab('Active'));
      expect(screen.getByText('Open Task')).toBeTruthy();
      expect(screen.getByText('In Progress Task')).toBeTruthy();
      expect(screen.queryByText('Blocked Task')).toBeNull();
    });

    it('tasks appear without manual refresh when signal updates', () => {
      mockTasksSignal.value = [];
      const { rerender } = render(<SpaceDetailPanel spaceId="space-1" />);

      // Verify empty state before an action-required task arrives.
      expect(screen.getByText('No tasks')).toBeTruthy();

      // Simulate new task arriving via event (signal update)
      mockTasksSignal.value = [makeTask('t-new', 'New Task', 'blocked')];
      rerender(<SpaceDetailPanel spaceId="space-1" />);

      expect(screen.getByText('New Task')).toBeTruthy();
      expect(screen.queryByText('No tasks')).toBeNull();
    });

    it('count badges update when new tasks arrive', () => {
      mockTasksSignal.value = [makeTask('t1', 'Task A', 'open')];
      const { rerender } = render(<SpaceDetailPanel spaceId="space-1" />);

      // Active: 1, Action: 0 — Tasks-nav badge hidden (action count = 0)
      expect(screen.getByText('1')).toBeTruthy();
      expect(screen.getByText('0')).toBeTruthy();

      // Add a blocked task
      mockTasksSignal.value = [
        makeTask('t1', 'Task A', 'open'),
        makeTask('t2', 'Task B', 'blocked'),
      ];
      rerender(<SpaceDetailPanel spaceId="space-1" />);

      // Active tab pill: 1, Action tab pill: 1, Tasks-nav badge: 1 → 3 elements
      const badges = screen.getAllByText('1');
      expect(badges.length).toBe(3);
    });

    it('task status change updates tab counts and visibility', () => {
      mockTasksSignal.value = [
        makeTask('t1', 'Task One', 'in_progress'),
        makeTask('t2', 'Task Two', 'blocked'),
      ];
      const { rerender } = render(<SpaceDetailPanel spaceId="space-1" />);

      // Action tab (default): shows blocked task
      expect(screen.getByText('Task Two')).toBeTruthy();

      // Simulate task status change: t1 becomes blocked, t2 becomes done
      mockTasksSignal.value = [
        makeTask('t1', 'Task One', 'blocked'),
        makeTask('t2', 'Task Two', 'done'),
      ];
      rerender(<SpaceDetailPanel spaceId="space-1" />);

      // Action tab should now show Task One (blocked) but not Task Two (done)
      expect(screen.getByText('Task One')).toBeTruthy();
      expect(screen.queryByText('Task Two')).toBeNull();
    });

    it('Tasks-nav badge counts blocked tasks even when no review tasks exist', () => {
      // Regression: previously the sidebar Tasks badge only counted
      // tasks the server-side `spaceTasks.needingAttention` query
      // returned (review + blocked-with-specific-reasons). Plain
      // blocked tasks shown under the Action tab were missed, so
      // e.g. 2 blocked / 0 review rendered no badge at all.
      mockTasksSignal.value = [
        makeTask('t1', 'Blocked One', 'blocked'),
        makeTask('t2', 'Blocked Two', 'blocked'),
      ];
      render(<SpaceDetailPanel spaceId="space-1" />);

      const tasksNav = screen.getByTestId('space-detail-tasks');
      expect(tasksNav).toBeTruthy();
      // The badge inside the Tasks nav row should read "2".
      expect(within(tasksNav).getByText('2')).toBeTruthy();
    });

    it('Tasks-nav badge stays in sync with the Action tab count', () => {
      mockTasksSignal.value = [
        makeTask('t1', 'Blocked Task', 'blocked'),
        makeTask('t2', 'Review Task', 'review'),
        makeTask('t3', 'Open Task', 'open'),
      ];
      render(<SpaceDetailPanel spaceId="space-1" />);

      // Action tab badge inside the tab pill shows "2" (blocked + review).
      const actionTabButton = screen.getByRole('button', { name: /Action/i });
      expect(within(actionTabButton).getByText('2')).toBeTruthy();

      // Sidebar Tasks badge should match.
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
      // No amber badge on the Tasks row — the only number on this row
      // would come from the badge, which renders only when count > 0.
      expect(within(tasksNav).queryByText('2')).toBeNull();
      expect(within(tasksNav).queryByText('1')).toBeNull();
    });

    it('shows approved (post-approval running) tasks under the Active tab', () => {
      // Regression: the sidebar "Active" tab and the main-pane Tasks
      // "Active" tab disagreed about `approved` tasks — the sidebar
      // hid them while the tasks-view surfaced them. Both now share
      // `isActiveTask` from `task-filters.ts`, which includes
      // `approved` so a stuck post-approval task stays visible.
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

      // Active count should include the approved task (2 = open + approved)
      const activeTab = getTaskTab('Active');
      expect(within(activeTab).getByText('2')).toBeTruthy();
    });

    it('multiple tasks created via different paths all appear in panel', () => {
      // Simulate tasks created via different paths: UI dialog, agent tool, workflow run
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

      // Switch to Active tab
      fireEvent.click(getTaskTab('Active'));

      // All three tasks should appear regardless of creation path
      expect(screen.getByText('UI Dialog Task')).toBeTruthy();
      expect(screen.getByText('Agent Created Task')).toBeTruthy();
      expect(screen.getByText('Workflow Task')).toBeTruthy();
    });
  });

  describe('sidebar list caps and View all links', () => {
    function makeTasks(count: number, status: SpaceTask['status'] = 'blocked') {
      // updatedAt ascending so the oldest tasks have the lowest ids — sorted
      // desc by recency, the low-id tasks are the ones that fall past the cap.
      return Array.from({ length: count }, (_, i) =>
        makeTask(`t${i}`, `Task ${String(i)}`, status, { updatedAt: i })
      );
    }

    function makeSessions(count: number) {
      // lastActiveAt ascending; sorted desc by recency the low-id sessions
      // fall past the cap. Insertion order is the same ascending order, so
      // without the recency sort the low-id sessions would be the VISIBLE ones.
      return Array.from({ length: count }, (_, i) => ({
        id: `s${i}`,
        title: `Session ${String(i)}`,
        status: 'active',
        lastActiveAt: i,
      }));
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
      // Oldest two (Task 0, Task 1) fall past the cap.
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
      // The other capped-out task stays hidden.
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
      // No action tasks but active tasks present → default tab resolves to 'active'.
      mockTasksSignal.value = [makeTask('t1', 'Open Task', 'open')];
      render(<SpaceDetailPanel spaceId="space-1" />);
      fireEvent.click(screen.getByTestId('space-detail-tasks'));
      expect(mockNavigateToSpaceTasks).toHaveBeenCalledWith('space-1', 'active');
    });

    it('renders exactly LIMIT sessions with no View all button', () => {
      mockSessionsSignal.value = makeSessions(10);
      render(<SpaceDetailPanel spaceId="space-1" />);
      expect(screen.queryByTestId('space-sessions-view-all')).toBeNull();
    });

    it('caps sessions at LIMIT (most-recent-first) and shows a View all button with the full count', () => {
      mockSessionsSignal.value = makeSessions(12);
      render(<SpaceDetailPanel spaceId="space-1" />);
      // The recency sort keeps the recent sessions; the two oldest are hidden.
      expect(screen.queryByText('Session 0')).toBeNull();
      expect(screen.queryByText('Session 1')).toBeNull();
      expect(screen.getByText('Session 2')).toBeTruthy();
      const btn = screen.getByTestId('space-sessions-view-all');
      expect(btn.textContent).toContain('12');
    });

    it('keeps a selected session that falls past the cap visible', () => {
      mockSessionsSignal.value = makeSessions(12);
      mockCurrentSpaceSessionIdSignal.value = 's0';
      render(<SpaceDetailPanel spaceId="space-1" />);
      expect(screen.getByText('Session 0')).toBeTruthy();
      expect(screen.queryByText('Session 1')).toBeNull();
    });

    it('View all sessions navigates to the sessions page', () => {
      mockSessionsSignal.value = makeSessions(12);
      render(<SpaceDetailPanel spaceId="space-1" />);
      fireEvent.click(screen.getByTestId('space-sessions-view-all'));
      expect(mockNavigateToSpaceSessions).toHaveBeenCalledWith('space-1');
    });
  });
});
