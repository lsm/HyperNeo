// @ts-nocheck
/**
 * Unit tests for SpaceTasks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceTask, TaskSchedule } from '@hyperneo/shared';

let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
const mockSchedules = signal<unknown[]>([]);
const mockListSchedules = vi.fn(async () => {});

// Bridge pattern: hoisted bridge objects allow mockNavigateToSpaceTasks to update
// the real Preact signals (which are created after import).
const { filterTabBridge, idBridge } = vi.hoisted(() => ({
  filterTabBridge: { signal: null as ReturnType<typeof signal<string>> | null },
  idBridge: { signal: null as ReturnType<typeof signal<string | null>> | null },
}));

// Hoisted mock for navigateToSpaceTasks — updates the real signal at call time
const { mockNavigateToSpaceTasks } = vi.hoisted(() => ({
  mockNavigateToSpaceTasks: vi.fn((_spaceId: string, tab: string) => {
    if (filterTabBridge.signal) {
      filterTabBridge.signal.value = tab;
    }
  }),
}));

// Plain holders for non-reactive signals (only read, not render)
const { mockCurrentSpaceIdSignal } = vi.hoisted(() => ({
  mockCurrentSpaceIdSignal: { value: null as string | null },
}));

// Hoisted spy for `fetchTaskGroup` so individual tests can override behaviour
// (e.g. simulate a transient RPC failure) and assert call counts. The default
// implementation mirrors the daemon repository pagination semantics so the
// component renders the same subset it would in production.
const { mockFetchTaskGroup } = vi.hoisted(() => ({
  mockFetchTaskGroup: vi.fn(),
}));

// Real Preact signal for the filter tab (read during render — needs reactivity)
const mockCurrentSpaceTasksFilterTabSignal = signal<string>('active');

// Wire bridge so mockNavigateToSpaceTasks can update the real signal
filterTabBridge.signal = mockCurrentSpaceTasksFilterTabSignal;
idBridge.signal = mockCurrentSpaceIdSignal;

vi.mock('../../../lib/signals', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    get currentSpaceTasksFilterTabSignal() {
      return mockCurrentSpaceTasksFilterTabSignal;
    },
    get currentSpaceIdSignal() {
      return mockCurrentSpaceIdSignal;
    },
  };
});

vi.mock('../../../lib/router', () => ({
  navigateToSpaceTasks: mockNavigateToSpaceTasks,
}));

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      tasks: mockTasks,
      schedules: mockSchedules,
      listSchedules: mockListSchedules,
      fetchTaskGroup: mockFetchTaskGroup,
    };
  },
}));

// Default implementation: filter `mockTasks` to mirror the daemon repository
// pagination semantics. Individual tests can override via
// `mockFetchTaskGroup.mockImplementationOnce(...)` to simulate failures.
function defaultFetchTaskGroupImpl(
  status: SpaceTask['status'],
  options?: {
    blockReason?: SpaceTask['blockReason'] | null;
    blockReasonNotIn?: string[];
    limit?: number;
    offset?: number;
  }
) {
  const limit = options?.limit ?? 10;
  const offset = options?.offset ?? 0;
  const all = (mockTasks.value as SpaceTask[])
    .filter((t) => {
      if (t.status !== status) return false;
      if (options && 'blockReason' in options) {
        if ((t.blockReason ?? null) !== (options.blockReason ?? null)) {
          return false;
        }
      }
      if (options?.blockReasonNotIn && options.blockReasonNotIn.length > 0) {
        if (t.blockReason && options.blockReasonNotIn.includes(t.blockReason)) {
          return false;
        }
      }
      return true;
    })
    // Match the repository's `ORDER BY updated_at DESC` so tests that
    // rely on sort order see the same view as production.
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return Promise.resolve({ tasks: all.slice(offset, offset + limit), total: all.length });
}

vi.mock('../../../lib/utils', () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(' '),
  formatRelativeFuture: () => 'in 1m',
  getRelativeTime: (ts: number) => `${Math.floor((Date.now() - ts) / 60_000)}m ago`,
}));

mockTasks = signal<SpaceTask[]>([]);

import { isActiveTask } from '../../../lib/task-filters';
import { SpaceTasks, TAB_PREDICATES } from '../SpaceTasks';

function makeTask(
  id: string,
  status: SpaceTask['status'] = 'open',
  overrides: Partial<SpaceTask> = {}
): SpaceTask {
  return {
    id,
    spaceId: 'space-1',
    taskNumber: Number(id.replace(/\D/g, '')) || 1,
    title: `Task ${id}`,
    description: '',
    status,
    priority: 'normal',
    labels: [],
    dependsOn: [],
    result: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function makeSchedule(id: string, overrides: Partial<TaskSchedule> = {}): TaskSchedule {
  return {
    id,
    spaceId: 'space-1',
    title: `Schedule ${id}`,
    description: '',
    priority: 'normal',
    preferredWorkflowId: null,
    labels: [],
    triggerType: 'cron',
    cronExpression: '0 9 * * 1',
    runAt: null,
    timezone: 'UTC',
    nextRunAt: Date.now() + 60_000,
    lastRunAt: null,
    lastCreatedTaskId: null,
    pendingJobId: null,
    status: 'active',
    createdByAgent: null,
    createdBySession: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('SpaceTasks', () => {
  beforeEach(() => {
    cleanup();
    mockTasks.value = [];
    mockSchedules.value = [];
    mockCurrentSpaceTasksFilterTabSignal.value = 'active';
    mockCurrentSpaceIdSignal.value = null;
    mockNavigateToSpaceTasks.mockClear();
    mockFetchTaskGroup.mockReset();
    mockFetchTaskGroup.mockImplementation(defaultFetchTaskGroupImpl);
  });

  afterEach(() => {
    cleanup();
    // Reset viewport width in case a test narrowed it for mobile overflow testing.
    Object.defineProperty(window, 'innerWidth', {
      value: 1024,
      configurable: true,
      writable: true,
    });
  });

  it('renders desktop tabs inline and removes the standalone Archived tab', () => {
    // Simulate narrow viewport so mobileTabCount=2 and the More overflow button appears.
    Object.defineProperty(window, 'innerWidth', {
      value: 0,
      configurable: true,
      writable: true,
    });
    mockTasks.value = [makeTask('t1', 'open')];
    const { getAllByText, queryByText, getByLabelText } = render(<SpaceTasks spaceId="space-1" />);
    expect(getAllByText('Action').length).toBeGreaterThan(0);
    expect(getAllByText('Active').length).toBeGreaterThan(0);
    expect(getAllByText('Completed').length).toBeGreaterThan(0);
    expect(getAllByText('Scheduled').length).toBeGreaterThan(0);
    expect(queryByText('Archived')).toBeNull();
    expect(getByLabelText('More task tabs')).toBeTruthy();
  });

  it('shows global empty state when there are no tasks at all', () => {
    const { getByText } = render(<SpaceTasks spaceId="space-1" />);
    expect(getByText('No tasks yet')).toBeTruthy();
    expect(getByText('Create a task to get started')).toBeTruthy();
  });

  it('shows empty state for action tab', () => {
    mockTasks.value = [makeTask('t1', 'open')];
    const { getAllByText, getByText } = render(<SpaceTasks spaceId="space-1" />);
    fireEvent.click(getAllByText('Action')[0]);
    expect(getByText('No tasks needing action')).toBeTruthy();
  });

  it('uses the route space id for tab navigation', () => {
    mockTasks.value = [makeTask('t1', 'open')];
    const { getAllByText } = render(
      <SpaceTasks spaceId="space-1" navigationSpaceId="space-slug" />
    );

    fireEvent.click(getAllByText('Action')[0]);

    expect(mockNavigateToSpaceTasks).toHaveBeenCalledWith('space-slug', 'action');
  });

  it('shows empty state for completed tab', () => {
    mockTasks.value = [makeTask('t1', 'open')];
    const { getAllByText, getByText } = render(<SpaceTasks spaceId="space-1" />);
    fireEvent.click(getAllByText('Completed')[0]);
    expect(getByText('No completed tasks')).toBeTruthy();
  });

  it('treats legacy archived routes as completed', async () => {
    mockCurrentSpaceTasksFilterTabSignal.value = 'archived';
    mockTasks.value = [makeTask('t1', 'archived')];
    const { findByText, getAllByText } = render(<SpaceTasks spaceId="space-1" />);
    expect(getAllByText('Completed')[0].className).toContain('text-green-400');
    expect(await findByText('Task t1')).toBeTruthy();
    expect(await findByText(/Archived \(1\)/)).toBeTruthy();
  });

  it('displays tasks in active tab (open + in_progress)', async () => {
    mockTasks.value = [makeTask('t1', 'open'), makeTask('t2', 'in_progress')];
    const { findByText, queryByText } = render(<SpaceTasks spaceId="space-1" />);
    expect(await findByText('Task t1')).toBeTruthy();
    expect(await findByText('Task t2')).toBeTruthy();
    expect(queryByText('No active tasks')).toBeNull();
  });

  it("surfaces 'approved' tasks inside the active tab (post-approval running)", async () => {
    // `approved` is a transient state between `approve_task` and
    // `mark_complete`. When stuck (post-approval dispatch fails and
    // `postApprovalBlockedReason` is populated), the task must remain
    // visible — routing it to Active keeps it in sight and the
    // PendingPostApprovalBanner on the detail pane surfaces the error.
    mockTasks.value = [makeTask('t1', 'approved')];
    const { findByText } = render(<SpaceTasks spaceId="space-1" />);
    expect(await findByText('Task t1')).toBeTruthy();
    expect(await findByText(/Post-Approval Running/)).toBeTruthy();
  });

  it('displays tasks in action tab (blocked + review)', async () => {
    mockTasks.value = [makeTask('t1', 'blocked'), makeTask('t2', 'review')];
    const { getAllByText, findByText } = render(<SpaceTasks spaceId="space-1" />);
    fireEvent.click(getAllByText('Action')[0]);
    expect(await findByText('Task t1')).toBeTruthy();
    expect(await findByText('Task t2')).toBeTruthy();
  });

  it('displays archived tasks in the completed tab as an Archived group', async () => {
    mockTasks.value = [
      makeTask('t1', 'done'),
      makeTask('t2', 'cancelled'),
      makeTask('t3', 'archived'),
    ];
    const { getAllByText, getByText, findByText } = render(<SpaceTasks spaceId="space-1" />);
    fireEvent.click(getAllByText('Completed')[0]);
    expect(await findByText('Task t1')).toBeTruthy();
    expect(await findByText('Task t2')).toBeTruthy();
    expect(await findByText('Task t3')).toBeTruthy();
    expect(getByText(/Archived \(1\)/)).toBeTruthy();
  });

  it('shows correct tab counts', () => {
    mockTasks.value = [
      makeTask('t1', 'open'),
      makeTask('t2', 'in_progress'),
      makeTask('t3', 'blocked'),
      makeTask('t4', 'review'),
      makeTask('t5', 'done'),
      makeTask('t6', 'cancelled'),
      makeTask('t7', 'archived'),
    ];
    const { container } = render(<SpaceTasks spaceId="space-1" />);
    const buttons = container.querySelectorAll('button');
    const text = Array.from(buttons).map((b) => b.textContent ?? '');

    expect(text.some((t) => t?.includes('Active') && t?.includes('2'))).toBe(true);
    expect(text.some((t) => t?.includes('Action') && t?.includes('2'))).toBe(true);
    expect(text.some((t) => t?.includes('Completed') && t?.includes('3'))).toBe(true);
    expect(text.some((t) => t?.includes('Archived'))).toBe(false);
  });

  it('shows secondary tabs and Scheduled in the mobile More dropdown', async () => {
    // Simulate narrow viewport so mobileTabCount=2 and draft/scheduled/completed go to overflow.
    Object.defineProperty(window, 'innerWidth', {
      value: 0,
      configurable: true,
      writable: true,
    });
    mockTasks.value = [
      makeTask('t1', 'open'),
      makeTask('t2', 'draft'),
      makeTask('t3', 'done'),
      makeTask('t4', 'archived'),
    ];
    mockSchedules.value = [makeSchedule('s1')];
    const { getByLabelText, findByRole } = render(<SpaceTasks spaceId="space-1" />);

    fireEvent.click(getByLabelText('More task tabs'));
    const draftsItem = await findByRole('menuitem', { name: /Drafts/ });
    const completedItem = await findByRole('menuitem', { name: /Completed/ });
    const scheduledItem = await findByRole('menuitem', { name: /Scheduled/ });
    expect(draftsItem.textContent).toContain('1');
    expect(completedItem.textContent).toContain('2');
    expect(scheduledItem.textContent).toContain('1');

    fireEvent.click(completedItem);

    expect(mockNavigateToSpaceTasks).toHaveBeenCalledWith('space-1', 'completed');
  });

  it('sorts tasks by updatedAt descending', async () => {
    const now = Date.now();
    mockTasks.value = [
      makeTask('t1', 'open', { updatedAt: now - 60_000 }),
      makeTask('t2', 'open', { updatedAt: now }),
      makeTask('t3', 'open', { updatedAt: now - 120_000 }),
    ];
    const { container } = render(<SpaceTasks spaceId="space-1" />);
    // Task items are inside TaskGroup cards
    await waitFor(() => {
      const taskItems = container.querySelectorAll('.divide-y > div');
      expect(taskItems.length).toBe(3);
    });
    const taskItems = container.querySelectorAll('.divide-y > div');
    expect(taskItems[0].textContent).toContain('Task t2');
    expect(taskItems[1].textContent).toContain('Task t1');
    expect(taskItems[2].textContent).toContain('Task t3');
  });

  it('calls onSelectTask when a task item is clicked', async () => {
    mockTasks.value = [makeTask('t1', 'open')];
    const onSelectTask = vi.fn();
    const { findByText } = render(<SpaceTasks spaceId="space-1" onSelectTask={onSelectTask} />);
    const node = await findByText('Task t1');
    fireEvent.click(node.closest('.border-l-2')!);
    expect(onSelectTask).toHaveBeenCalledWith('t1');
  });

  it('renders status label and relative time for each task', async () => {
    mockTasks.value = [makeTask('t1', 'in_progress')];
    const { findByText } = render(<SpaceTasks spaceId="space-1" />);
    expect(await findByText('In Progress')).toBeTruthy();
  });

  it('renders task number badge', async () => {
    mockTasks.value = [makeTask('t1', 'open', { taskNumber: 42 })];
    const { findByText } = render(<SpaceTasks spaceId="space-1" />);
    expect(await findByText('#42')).toBeTruthy();
  });

  it('does not show count badge when count is 0', () => {
    mockTasks.value = [];
    const { container } = render(<SpaceTasks spaceId="space-1" />);
    // The tab strip is always visible (so users can reach the Scheduled tab
    // even when no tasks exist yet), but the Active tab should not have a
    // count badge when its count is zero.
    const activeButtons = Array.from(container.querySelectorAll('button'));
    const activeTab = activeButtons.find((b) => b.textContent?.includes('Active'));
    expect(activeTab).toBeTruthy();
    expect(activeTab!.textContent).toBe('Active'); // no "(0)" suffix
  });

  it('switches tabs and shows filtered tasks', async () => {
    mockTasks.value = [makeTask('t1', 'open'), makeTask('t2', 'done')];
    const { getAllByText, findByText, queryByText } = render(<SpaceTasks spaceId="space-1" />);

    // Active tab shows t1
    expect(await findByText('Task t1')).toBeTruthy();
    expect(queryByText('Task t2')).toBeNull();

    // Switch to completed
    fireEvent.click(getAllByText('Completed')[0]);
    expect(await findByText('Task t2')).toBeTruthy();
    expect(queryByText('Task t1')).toBeNull();
  });

  it('groups tasks by status within a tab', () => {
    mockTasks.value = [makeTask('t1', 'in_progress'), makeTask('t2', 'open')];
    const { getByText } = render(<SpaceTasks spaceId="space-1" />);

    // Active tab should show two groups: "In Progress" and "Open"
    expect(getByText(/In Progress \(1\)/)).toBeTruthy();
    expect(getByText(/Open \(1\)/)).toBeTruthy();
  });

  it('only shows non-empty groups within a tab', () => {
    mockTasks.value = [makeTask('t1', 'in_progress')];
    const { getByText, queryByText } = render(<SpaceTasks spaceId="space-1" />);

    // In Progress group shown
    expect(getByText(/In Progress \(1\)/)).toBeTruthy();
    // Open group not shown (no open tasks)
    expect(queryByText(/Open \(/)).toBeNull();
  });

  describe('Dependency badges', () => {
    it('renders no badge row when a task has no dependencies', () => {
      mockTasks.value = [makeTask('t1', 'open')];
      const { queryByTestId } = render(<SpaceTasks spaceId="space-1" />);
      expect(queryByTestId('task-dependency-badges')).toBeNull();
    });

    it('renders a gray badge when the dependency is not done', async () => {
      mockTasks.value = [
        makeTask('t1', 'open', { taskNumber: 1 }),
        makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['t1'] }),
      ];
      const { findAllByTestId } = render(<SpaceTasks spaceId="space-1" />);
      const badges = await findAllByTestId('task-dependency-badge');
      expect(badges).toHaveLength(1);
      expect(badges[0].textContent).toContain('#1');
      expect(badges[0].getAttribute('data-dep-status')).toBe('open');
      // Gray color classes applied (bg-dark-700 / text-gray-300)
      expect(badges[0].className).toContain('text-gray-300');
      expect(badges[0].className).not.toContain('text-green-300');
    });

    it('renders a green badge when the dependency is done', async () => {
      mockTasks.value = [
        makeTask('t1', 'done', { taskNumber: 1 }),
        makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['t1'] }),
      ];
      const { findAllByTestId } = render(<SpaceTasks spaceId="space-1" />);
      const badges = await findAllByTestId('task-dependency-badge');
      expect(badges).toHaveLength(1);
      expect(badges[0].getAttribute('data-dep-status')).toBe('done');
      expect(badges[0].className).toContain('text-green-300');
    });

    it('renders a missing-dep badge with ⚠ when the dep id is not found', async () => {
      mockTasks.value = [makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['missing-id'] })];
      const { findAllByTestId } = render(<SpaceTasks spaceId="space-1" />);
      const badges = await findAllByTestId('task-dependency-badge');
      expect(badges).toHaveLength(1);
      expect(badges[0].getAttribute('data-dep-status')).toBe('missing');
      expect(badges[0].getAttribute('title')).toBe('task not found');
      expect(badges[0].textContent).toContain('⚠');
      expect(badges[0].textContent).toContain('#?');
      expect((badges[0] as HTMLButtonElement).disabled).toBe(true);
      // Disabled badges should not carry hover: classes.
      expect(badges[0].className).not.toMatch(/\bhover:/);
    });

    it('shows the dep task title as the tooltip', async () => {
      mockTasks.value = [
        makeTask('t1', 'open', { taskNumber: 1, title: 'Set up auth' }),
        makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['t1'] }),
      ];
      const { findAllByTestId } = render(<SpaceTasks spaceId="space-1" />);
      const badges = await findAllByTestId('task-dependency-badge');
      expect(badges[0].getAttribute('title')).toBe('Set up auth');
    });

    it('navigates to the dependency task when a badge is clicked', async () => {
      mockTasks.value = [
        makeTask('t1', 'open', { taskNumber: 1 }),
        makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['t1'] }),
      ];
      const onSelectTask = vi.fn();
      const { findAllByTestId } = render(
        <SpaceTasks spaceId="space-1" onSelectTask={onSelectTask} />
      );
      const badges = await findAllByTestId('task-dependency-badge');
      fireEvent.click(badges[0]);
      expect(onSelectTask).toHaveBeenCalledWith('t1');
      // Must not also select the parent row (stopPropagation)
      expect(onSelectTask).toHaveBeenCalledTimes(1);
      // Interactive badges carry hover: classes for feedback.
      expect(badges[0].className).toMatch(/\bhover:/);
    });

    it('does not invoke onSelectTask for a missing dependency', async () => {
      mockTasks.value = [makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['ghost'] })];
      const onSelectTask = vi.fn();
      const { findAllByTestId } = render(
        <SpaceTasks spaceId="space-1" onSelectTask={onSelectTask} />
      );
      const badges = await findAllByTestId('task-dependency-badge');
      fireEvent.click(badges[0]);
      expect(onSelectTask).not.toHaveBeenCalled();
    });

    it('shows overflow chip when there are more than 3 deps (first 3 + "+N")', async () => {
      mockTasks.value = [
        makeTask('t1', 'done', { taskNumber: 1 }),
        makeTask('t2', 'open', { taskNumber: 2 }),
        makeTask('t3', 'blocked', { taskNumber: 3 }),
        makeTask('t4', 'done', { taskNumber: 4 }),
        makeTask('t5', 'open', { taskNumber: 5 }),
        makeTask('target', 'open', {
          taskNumber: 99,
          dependsOn: ['t1', 't2', 't3', 't4', 't5'],
        }),
      ];
      const { findAllByTestId, getByTestId } = render(<SpaceTasks spaceId="space-1" />);
      const badges = await findAllByTestId('task-dependency-badge');
      // Only the first 3 deps render as badges
      expect(badges).toHaveLength(3);
      expect(badges.map((b) => b.textContent)).toEqual(['#1', '#2', '#3']);
      const overflow = getByTestId('task-dependency-overflow');
      expect(overflow.textContent).toBe('+2');
    });

    it('does not show an overflow chip when there are exactly 3 deps', async () => {
      mockTasks.value = [
        makeTask('t1', 'done', { taskNumber: 1 }),
        makeTask('t2', 'done', { taskNumber: 2 }),
        makeTask('t3', 'done', { taskNumber: 3 }),
        makeTask('target', 'open', {
          taskNumber: 99,
          dependsOn: ['t1', 't2', 't3'],
        }),
      ];
      const { findAllByTestId, queryByTestId } = render(<SpaceTasks spaceId="space-1" />);
      expect(await findAllByTestId('task-dependency-badge')).toHaveLength(3);
      expect(queryByTestId('task-dependency-overflow')).toBeNull();
    });

    it('reacts when a dependency transitions to done', async () => {
      mockTasks.value = [
        makeTask('t1', 'in_progress', { taskNumber: 1 }),
        makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['t1'] }),
      ];
      const { findAllByTestId, getAllByTestId, rerender } = render(
        <SpaceTasks spaceId="space-1" />
      );
      let badges = await findAllByTestId('task-dependency-badge');
      expect(badges[0].getAttribute('data-dep-status')).toBe('in_progress');
      expect(badges[0].className).toContain('text-gray-300');

      // Dependency completes → the badge should flip to green
      mockTasks.value = [
        makeTask('t1', 'done', { taskNumber: 1 }),
        makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['t1'] }),
      ];
      rerender(<SpaceTasks spaceId="space-1" />);
      await waitFor(() => {
        badges = getAllByTestId('task-dependency-badge');
        expect(badges[0].getAttribute('data-dep-status')).toBe('done');
      });
      expect(badges[0].className).toContain('text-green-300');
    });
  });

  describe("Active-tab parity with sidebar's isActiveTask", () => {
    // The sidebar in `SpaceDetailPanel` calls `isActiveTask` directly;
    // the tasks-view here goes through `TAB_PREDICATES.active`. This
    // suite asserts those two paths agree across every `SpaceTaskStatus`,
    // so a future re-inlining of the predicate in `SpaceTasks.tsx` (the
    // shape the original bug took) would fail loudly here rather than
    // silently shipping diverging Active lists.
    const ALL_STATUSES: SpaceTask['status'][] = [
      'open',
      'in_progress',
      'review',
      'approved',
      'done',
      'blocked',
      'cancelled',
      'archived',
    ];

    it('TAB_PREDICATES.active and isActiveTask classify every status identically', () => {
      for (const status of ALL_STATUSES) {
        const task = makeTask(`t-${status}`, status);
        expect({ status, value: TAB_PREDICATES.active(task) }).toEqual({
          status,
          value: isActiveTask(task),
        });
      }
    });

    it('produces the same set of task IDs as the sidebar over a heterogeneous fixture', () => {
      // Mirrors the bug scenario: a mixed list including approved
      // rows. Both consumers must select the exact same IDs.
      const fixture: SpaceTask[] = [
        makeTask('t-open-1', 'open'),
        makeTask('t-open-2', 'open'),
        makeTask('t-inprog', 'in_progress'),
        makeTask('t-review', 'review'),
        makeTask('t-approved-1', 'approved'),
        makeTask('t-approved-2', 'approved'),
        makeTask('t-done', 'done'),
        makeTask('t-blocked', 'blocked'),
        makeTask('t-cancelled', 'cancelled'),
        makeTask('t-archived', 'archived'),
      ];

      const sidebarIds = fixture
        .filter(isActiveTask)
        .map((t) => t.id)
        .sort();
      const tasksViewIds = fixture
        .filter(TAB_PREDICATES.active)
        .map((t) => t.id)
        .sort();

      expect(tasksViewIds).toEqual(sidebarIds);
      expect(sidebarIds).toEqual(
        ['t-approved-1', 't-approved-2', 't-inprog', 't-open-1', 't-open-2'].sort()
      );
    });
  });

  describe('Paginated group refresh & error/loading semantics', () => {
    it('refetches when a task is edited within the same status (count stable)', async () => {
      // Two tasks in `in_progress`. The user edits one (title changes
      // without altering status), bumping `updatedAt`. The fetch effect
      // should re-run because `contentSig` changed, even though
      // `localCount` stays at 2.
      const now = Date.now();
      mockTasks.value = [
        makeTask('t1', 'in_progress', { taskNumber: 1, updatedAt: now - 1000 }),
        makeTask('t2', 'in_progress', { taskNumber: 2, updatedAt: now - 2000 }),
      ];
      const { findByText } = render(<SpaceTasks spaceId="space-1" />);
      expect(await findByText('Task t1')).toBeTruthy();
      const callsAfterMount = mockFetchTaskGroup.mock.calls.length;
      expect(callsAfterMount).toBeGreaterThan(0);

      // Mutate t1 — same status, new updatedAt and title
      mockTasks.value = [
        makeTask('t1', 'in_progress', {
          taskNumber: 1,
          updatedAt: now,
          title: 'Task t1 (edited)',
        }),
        makeTask('t2', 'in_progress', { taskNumber: 2, updatedAt: now - 2000 }),
      ];
      await waitFor(() => {
        expect(mockFetchTaskGroup.mock.calls.length).toBeGreaterThan(callsAfterMount);
      });
    });

    it('refetches when the active spaceId changes', async () => {
      // Render under space-1 with two tasks. Switch the signal to
      // space-2 and assert the fetch effect re-ran. Without `spaceId`
      // in the group key, a stable (title, status, blockReason,
      // localCount, offset) tuple across spaces would silently leak
      // rows from the previous space.
      mockCurrentSpaceIdSignal.value = 'space-1';
      mockTasks.value = [
        makeTask('t1', 'in_progress', { taskNumber: 1 }),
        makeTask('t2', 'in_progress', { taskNumber: 2 }),
      ];
      const { findByText, rerender } = render(<SpaceTasks spaceId="space-1" />);
      expect(await findByText('Task t1')).toBeTruthy();
      const callsBefore = mockFetchTaskGroup.mock.calls.length;

      mockCurrentSpaceIdSignal.value = 'space-2';
      rerender(<SpaceTasks spaceId="space-2" />);
      await waitFor(() => {
        expect(mockFetchTaskGroup.mock.calls.length).toBeGreaterThan(callsBefore);
      });
    });

    it('preserves pagination footer and surfaces a Retry banner on fetch error', async () => {
      // Seed >10 tasks so pagination would render. First call resolves
      // (mount succeeds → footer rendered), second call rejects
      // (simulated transient RPC failure on Next click). The footer
      // must still be in the DOM and the body must show a Retry button.
      const tasks: SpaceTask[] = [];
      for (let i = 0; i < 15; i++) {
        tasks.push(makeTask(`t${i}`, 'in_progress', { taskNumber: i }));
      }
      mockTasks.value = tasks;

      // First call (mount) uses the default impl. Second call rejects.
      mockFetchTaskGroup.mockImplementationOnce(defaultFetchTaskGroupImpl);
      mockFetchTaskGroup.mockImplementationOnce(() => Promise.reject(new Error('network')));

      const { findByTestId, getByTestId } = render(<SpaceTasks spaceId="space-1" />);
      // Pagination footer renders after the initial fetch.
      await findByTestId('task-group-pagination');

      fireEvent.click(getByTestId('task-group-next'));

      // Error banner appears and the footer survives the failure.
      await findByTestId('task-group-error');
      expect(getByTestId('task-group-pagination')).toBeTruthy();
      expect(getByTestId('task-group-retry')).toBeTruthy();
    });

    it('Retry re-issues the fetch after an error and restores rows on success', async () => {
      const tasks: SpaceTask[] = [];
      for (let i = 0; i < 15; i++) {
        tasks.push(makeTask(`t${i}`, 'in_progress', { taskNumber: i }));
      }
      mockTasks.value = tasks;

      mockFetchTaskGroup.mockImplementationOnce(defaultFetchTaskGroupImpl);
      mockFetchTaskGroup.mockImplementationOnce(() => Promise.reject(new Error('network')));
      // Third call (Retry) succeeds.
      mockFetchTaskGroup.mockImplementationOnce(defaultFetchTaskGroupImpl);

      const { findByTestId, getByTestId, queryByTestId } = render(<SpaceTasks spaceId="space-1" />);
      await findByTestId('task-group-pagination');
      fireEvent.click(getByTestId('task-group-next'));
      await findByTestId('task-group-error');

      fireEvent.click(getByTestId('task-group-retry'));
      await waitFor(() => {
        expect(queryByTestId('task-group-error')).toBeNull();
      });
    });

    it('clears visible rows and shows a loading placeholder on Prev/Next click', async () => {
      // 15 in_progress tasks → pagination renders (limit=10, total=15).
      // Stage the second fetch (Next click) on a deferred promise so we
      // can observe the in-between state where rows are cleared and the
      // loading placeholder is visible.
      const tasks: SpaceTask[] = [];
      for (let i = 0; i < 15; i++) {
        tasks.push(
          makeTask(`t${String(i).padStart(2, '0')}`, 'in_progress', {
            taskNumber: i,
            updatedAt: Date.now() - i * 1000,
          })
        );
      }
      mockTasks.value = tasks;

      let resolveNext: (value: { tasks: SpaceTask[]; total: number }) => void = () => {};
      mockFetchTaskGroup.mockImplementationOnce(defaultFetchTaskGroupImpl);
      mockFetchTaskGroup.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNext = resolve;
          })
      );

      const { findByText, getByTestId, findByTestId, queryByText } = render(
        <SpaceTasks spaceId="space-1" />
      );
      // First page rendered.
      expect(await findByText('Task t00')).toBeTruthy();

      fireEvent.click(getByTestId('task-group-next'));

      // While the Next request is pending, the previous page's rows
      // must be hidden and a loading placeholder shown — otherwise the
      // user could click into a row that no longer belongs to the
      // "Showing 11–20" range now reflected in the footer.
      await findByTestId('task-group-loading');
      expect(queryByText('Task t00')).toBeNull();

      // Resolve the deferred fetch with the next page.
      resolveNext({ tasks: tasks.slice(10, 15), total: 15 });
      expect(await findByText('Task t10')).toBeTruthy();
    });
  });
});
