// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceTask, TaskSchedule } from '@hyperneo/shared';

let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
const mockSchedules = signal<unknown[]>([]);
const mockWorkspaces = signal<unknown[]>([]);
const mockListSchedules = vi.fn(async () => {});

const { filterTabBridge, idBridge } = vi.hoisted(() => ({
  filterTabBridge: { signal: null as ReturnType<typeof signal<string>> | null },
  idBridge: { signal: null as ReturnType<typeof signal<string | null>> | null },
}));

const { mockNavigateToSpaceTasks } = vi.hoisted(() => ({
  mockNavigateToSpaceTasks: vi.fn((_spaceId: string, tab: string) => {
    if (filterTabBridge.signal) {
      filterTabBridge.signal.value = tab;
    }
  }),
}));

const { mockCurrentSpaceIdSignal } = vi.hoisted(() => ({
  mockCurrentSpaceIdSignal: { value: null as string | null },
}));

const { mockFetchTaskGroup } = vi.hoisted(() => ({
  mockFetchTaskGroup: vi.fn(),
}));

const mockCurrentSpaceTasksFilterTabSignal = signal<string>('active');

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
      workspaces: mockWorkspaces,
      listSchedules: mockListSchedules,
      fetchTaskGroup: mockFetchTaskGroup,
    };
  },
}));

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
    mockWorkspaces.value = [];
    mockCurrentSpaceTasksFilterTabSignal.value = 'active';
    mockCurrentSpaceIdSignal.value = null;
    mockNavigateToSpaceTasks.mockClear();
    mockFetchTaskGroup.mockReset();
    mockFetchTaskGroup.mockImplementation(defaultFetchTaskGroupImpl);
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'innerWidth', {
      value: 1024,
      configurable: true,
      writable: true,
    });
  });

  it('renders the available tabs and removes the standalone Archived tab', () => {
    mockTasks.value = [makeTask('t1', 'open')];
    const { getAllByText, queryByText } = render(<SpaceTasks spaceId="space-1" />);
    expect(getAllByText('Action').length).toBeGreaterThan(0);
    expect(getAllByText('Active').length).toBeGreaterThan(0);
    expect(getAllByText('Completed').length).toBeGreaterThan(0);
    expect(getAllByText('Scheduled').length).toBeGreaterThan(0);
    expect(queryByText('Archived')).toBeNull();
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
    const completedButtons = getAllByText('Completed');
    expect(
      completedButtons.some((el) => el.closest('button')?.getAttribute('aria-pressed') === 'true')
    ).toBe(true);
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

  it('refetches a task group when a truncated-summary task advances only in updatedAt', async () => {
    mockCurrentSpaceTasksFilterTabSignal.value = 'action';
    const blocked = {
      ...makeTask('t1', 'blocked', {
        blockReason: 'agent_error',
        result: 'truncated prefix',
        updatedAt: 1000,
      }),
      resultTruncated: true,
    };
    mockTasks.value = [blocked];
    render(<SpaceTasks spaceId="space-1" />);
    await waitFor(() => expect(mockFetchTaskGroup).toHaveBeenCalled());
    mockFetchTaskGroup.mockClear();

    act(() => {
      mockTasks.value = [{ ...blocked, updatedAt: 2000 }];
    });

    await waitFor(() => expect(mockFetchTaskGroup).toHaveBeenCalled());
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
      makeTask('t8', 'stopped'),
    ];
    const { container } = render(<SpaceTasks spaceId="space-1" />);
    const buttons = container.querySelectorAll('button');
    const text = Array.from(buttons).map((b) => b.textContent ?? '');

    expect(text.some((t) => t?.includes('Active') && t?.includes('3'))).toBe(true);
    expect(text.some((t) => t?.includes('Action') && t?.includes('2'))).toBe(true);
    expect(text.some((t) => t?.includes('Completed') && t?.includes('3'))).toBe(true);
    expect(text.some((t) => t?.includes('Archived'))).toBe(false);
  });

  it('shows the final secondary tab in the compact More dropdown', async () => {
    mockTasks.value = [
      makeTask('t1', 'open'),
      makeTask('t2', 'draft'),
      makeTask('t3', 'done'),
      makeTask('t4', 'archived'),
    ];
    mockSchedules.value = [makeSchedule('s1')];
    const { getByLabelText, findByRole, getAllByText } = render(<SpaceTasks spaceId="space-1" />);

    expect(getAllByText('Drafts').length).toBeGreaterThan(0);
    expect(getAllByText('Scheduled').length).toBeGreaterThan(0);
    fireEvent.click(getByLabelText('More task tabs'));
    const completedItem = await findByRole('menuitem', { name: /Completed/ });
    expect(completedItem.textContent).toContain('2');

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
    fireEvent.click(node.closest('[data-testid="space-task-item"]')!);
    expect(onSelectTask).toHaveBeenCalledWith('t1');
  });

  it('uses the group heading for status without repeating it in the task row', async () => {
    mockTasks.value = [makeTask('t1', 'in_progress')];
    const { findByRole, findByText, queryAllByText } = render(<SpaceTasks spaceId="space-1" />);
    expect(await findByRole('heading', { name: 'In Progress (1)' })).toBeTruthy();
    expect(await findByText(/Updated/)).toBeTruthy();
    expect(queryAllByText('In Progress')).toHaveLength(0);
  });

  it('opens a task row with Enter or Space', async () => {
    mockTasks.value = [makeTask('t1', 'open')];
    const onSelectTask = vi.fn();
    const { findByRole } = render(<SpaceTasks spaceId="space-1" onSelectTask={onSelectTask} />);
    const row = await findByRole('button', { name: 'Open task #1: Task t1' });

    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });

    expect(onSelectTask).toHaveBeenNthCalledWith(1, 't1');
    expect(onSelectTask).toHaveBeenNthCalledWith(2, 't1');
  });

  it('renders task number badge', async () => {
    mockTasks.value = [makeTask('t1', 'open', { taskNumber: 42 })];
    const { findByText } = render(<SpaceTasks spaceId="space-1" />);
    expect(await findByText('#42')).toBeTruthy();
  });

  it('shows workspace badge for non-primary-bound tasks and hides it for primary-bound tasks', async () => {
    mockWorkspaces.value = [
      { id: 'ws-1', spaceId: 'space-1', path: '/primary', label: 'Main', isPrimary: true },
      { id: 'ws-2', spaceId: 'space-1', path: '/secondary/docs', label: 'Docs', isPrimary: false },
    ];
    mockTasks.value = [
      makeTask('t1', 'open', { workspacePath: '/primary' }),
      makeTask('t2', 'open', { workspacePath: '/secondary/docs' }),
    ];
    const { findAllByTestId, getByText } = render(<SpaceTasks spaceId="space-1" />);
    const badges = await findAllByTestId('task-workspace-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe('Docs');
    expect(getByText('Task t1')).toBeTruthy();
    expect(getByText('Task t2')).toBeTruthy();
  });

  it('does not show count badge when count is 0', () => {
    mockTasks.value = [];
    const { container } = render(<SpaceTasks spaceId="space-1" />);
    const activeButtons = Array.from(container.querySelectorAll('button'));
    const activeTab = activeButtons.find((b) => b.textContent?.includes('Active'));
    expect(activeTab).toBeTruthy();
    expect(activeTab!.textContent).toBe('Active');
  });

  it('switches tabs and shows filtered tasks', async () => {
    mockTasks.value = [makeTask('t1', 'open'), makeTask('t2', 'done')];
    const { getAllByText, findByText, queryByText } = render(<SpaceTasks spaceId="space-1" />);

    expect(await findByText('Task t1')).toBeTruthy();
    expect(queryByText('Task t2')).toBeNull();

    fireEvent.click(getAllByText('Completed')[0]);
    expect(await findByText('Task t2')).toBeTruthy();
    expect(queryByText('Task t1')).toBeNull();
  });

  it('groups tasks by status within a tab', () => {
    mockTasks.value = [makeTask('t1', 'in_progress'), makeTask('t2', 'open')];
    const { getByText } = render(<SpaceTasks spaceId="space-1" />);

    expect(getByText(/In Progress \(1\)/)).toBeTruthy();
    expect(getByText(/Open \(1\)/)).toBeTruthy();
  });

  it('only shows non-empty groups within a tab', () => {
    mockTasks.value = [makeTask('t1', 'in_progress')];
    const { getByText, queryByText } = render(<SpaceTasks spaceId="space-1" />);

    expect(getByText(/In Progress \(1\)/)).toBeTruthy();
    expect(queryByText(/Open \(/)).toBeNull();
  });

  it("surfaces 'stopped' tasks inside the active tab as their own Stopped group", async () => {
    mockTasks.value = [makeTask('t1', 'stopped')];
    const { findByText, getByText, queryByText } = render(<SpaceTasks spaceId="space-1" />);
    expect(await findByText('Task t1')).toBeTruthy();
    expect(getByText(/Stopped \(1\)/)).toBeTruthy();
    expect(queryByText(/Open \(/)).toBeNull();
  });

  it('renders the Stopped group with its own gray accent, distinct from In Progress amber', () => {
    mockTasks.value = [makeTask('t1', 'in_progress'), makeTask('t2', 'stopped')];
    const { getByText } = render(<SpaceTasks spaceId="space-1" />);

    const groupDot = (heading: HTMLElement) =>
      heading.parentElement?.querySelector('span.rounded-full');

    expect(getByText(/In Progress \(1\)/)).toBeTruthy();
    expect(getByText(/Stopped \(1\)/)).toBeTruthy();
    expect(groupDot(getByText(/In Progress \(1\)/))?.className).toContain('bg-warning/80');
    expect(groupDot(getByText(/Stopped \(1\)/))?.className).toContain('bg-fg-muted/80');
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
      expect(badges[0].className).toContain('text-fg-soft');
      expect(badges[0].className).not.toContain('text-success-soft');
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
      expect(badges[0].className).toContain('text-success-soft');
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
      expect(onSelectTask).toHaveBeenCalledTimes(1);
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
      expect(badges[0].className).toContain('text-fg-soft');

      mockTasks.value = [
        makeTask('t1', 'done', { taskNumber: 1 }),
        makeTask('t2', 'open', { taskNumber: 2, dependsOn: ['t1'] }),
      ];
      rerender(<SpaceTasks spaceId="space-1" />);
      await waitFor(() => {
        badges = getAllByTestId('task-dependency-badge');
        expect(badges[0].getAttribute('data-dep-status')).toBe('done');
      });
      expect(badges[0].className).toContain('text-success-soft');
    });
  });

  describe("Active-tab parity with sidebar's isActiveTask", () => {
    const ALL_STATUSES: SpaceTask['status'][] = [
      'open',
      'in_progress',
      'review',
      'approved',
      'done',
      'blocked',
      'cancelled',
      'archived',
      'stopped',
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
        makeTask('t-stopped', 'stopped'),
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
        ['t-approved-1', 't-approved-2', 't-inprog', 't-open-1', 't-open-2', 't-stopped'].sort()
      );
    });
  });

  describe('Paginated group refresh & error/loading semantics', () => {
    it('does NOT refetch when only updatedAt advances (running-task step churn)', async () => {
      const now = Date.now();
      mockTasks.value = [
        makeTask('t1', 'in_progress', { taskNumber: 1, updatedAt: now - 1000 }),
        makeTask('t2', 'in_progress', { taskNumber: 2, updatedAt: now - 2000 }),
      ];
      const { findByText, rerender } = render(<SpaceTasks spaceId="space-1" />);
      expect(await findByText('Task t1')).toBeTruthy();
      await waitFor(() => {
        expect(mockFetchTaskGroup).toHaveBeenCalled();
      });
      const callsAfterMount = mockFetchTaskGroup.mock.calls.length;
      expect(callsAfterMount).toBeGreaterThan(0);

      mockTasks.value = [
        makeTask('t1', 'in_progress', { taskNumber: 1, updatedAt: now }),
        makeTask('t2', 'in_progress', { taskNumber: 2, updatedAt: now - 2000 }),
      ];
      rerender(<SpaceTasks spaceId="space-1" />);
      await new Promise((r) => setTimeout(r, 0));
      expect(mockFetchTaskGroup.mock.calls.length).toBe(callsAfterMount);
    });

    it('refetches when a displayed field is edited within the same status', async () => {
      const now = Date.now();
      mockTasks.value = [
        makeTask('t1', 'in_progress', { taskNumber: 1, updatedAt: now - 1000 }),
        makeTask('t2', 'in_progress', { taskNumber: 2, updatedAt: now - 2000 }),
      ];
      const { findByText, rerender } = render(<SpaceTasks spaceId="space-1" />);
      expect(await findByText('Task t1')).toBeTruthy();
      await waitFor(() => {
        expect(mockFetchTaskGroup).toHaveBeenCalled();
      });
      const callsAfterMount = mockFetchTaskGroup.mock.calls.length;

      mockTasks.value = [
        makeTask('t1', 'in_progress', {
          taskNumber: 1,
          updatedAt: now,
          title: 'Task t1 (edited)',
        }),
        makeTask('t2', 'in_progress', { taskNumber: 2, updatedAt: now - 2000 }),
      ];
      rerender(<SpaceTasks spaceId="space-1" />);
      await waitFor(() => {
        expect(mockFetchTaskGroup.mock.calls.length).toBeGreaterThan(callsAfterMount);
      });
    });

    it('refetches when a task result changes (blocked-row reason refresh)', async () => {
      const now = Date.now();
      mockTasks.value = [
        makeTask('t1', 'in_progress', { taskNumber: 1, updatedAt: now - 1000, result: null }),
        makeTask('t2', 'in_progress', { taskNumber: 2, updatedAt: now - 2000 }),
      ];
      const { findByText, rerender } = render(<SpaceTasks spaceId="space-1" />);
      expect(await findByText('Task t1')).toBeTruthy();
      await waitFor(() => {
        expect(mockFetchTaskGroup).toHaveBeenCalled();
      });
      const callsAfterMount = mockFetchTaskGroup.mock.calls.length;

      mockTasks.value = [
        makeTask('t1', 'in_progress', {
          taskNumber: 1,
          updatedAt: now - 1000,
          result: 'Blocked: needs human input',
        }),
        makeTask('t2', 'in_progress', { taskNumber: 2, updatedAt: now - 2000 }),
      ];
      rerender(<SpaceTasks spaceId="space-1" />);
      await waitFor(() => {
        expect(mockFetchTaskGroup.mock.calls.length).toBeGreaterThan(callsAfterMount);
      });
    });

    it('refetches when a task workspace binding changes', async () => {
      const now = Date.now();
      mockTasks.value = [
        makeTask('t1', 'in_progress', { taskNumber: 1, updatedAt: now - 1000 }),
        makeTask('t2', 'in_progress', { taskNumber: 2, updatedAt: now - 2000 }),
      ];
      const { findByText, rerender } = render(<SpaceTasks spaceId="space-1" />);
      expect(await findByText('Task t1')).toBeTruthy();
      await waitFor(() => {
        expect(mockFetchTaskGroup).toHaveBeenCalled();
      });
      const callsAfterMount = mockFetchTaskGroup.mock.calls.length;

      mockTasks.value = [
        makeTask('t1', 'in_progress', {
          taskNumber: 1,
          updatedAt: now - 1000,
          workspacePath: '/spaces/s1/docs',
        }),
        makeTask('t2', 'in_progress', { taskNumber: 2, updatedAt: now - 2000 }),
      ];
      rerender(<SpaceTasks spaceId="space-1" />);
      await waitFor(() => {
        expect(mockFetchTaskGroup.mock.calls.length).toBeGreaterThan(callsAfterMount);
      });
    });

    it('refetches when the active spaceId changes', async () => {
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
      const tasks: SpaceTask[] = [];
      for (let i = 0; i < 15; i++) {
        tasks.push(makeTask(`t${i}`, 'in_progress', { taskNumber: i }));
      }
      mockTasks.value = tasks;

      mockFetchTaskGroup.mockImplementationOnce(defaultFetchTaskGroupImpl);
      mockFetchTaskGroup.mockImplementationOnce(() => Promise.reject(new Error('network')));

      const { findByTestId, getByTestId } = render(<SpaceTasks spaceId="space-1" />);
      await findByTestId('task-group-pagination');

      fireEvent.click(getByTestId('task-group-next'));

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
      expect(await findByText('Task t00')).toBeTruthy();

      fireEvent.click(getByTestId('task-group-next'));

      await findByTestId('task-group-loading');
      expect(queryByText('Task t00')).toBeNull();

      resolveNext({ tasks: tasks.slice(10, 15), total: 15 });
      expect(await findByText('Task t10')).toBeTruthy();
    });
  });
});
