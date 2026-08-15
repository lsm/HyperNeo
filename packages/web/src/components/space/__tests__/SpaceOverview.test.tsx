// @ts-nocheck
/**
 * Unit tests for SpaceOverview.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { RuntimeState, Space, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';

let mockSpace: ReturnType<typeof signal<Space | null>>;
let mockLoading: ReturnType<typeof signal<boolean>>;
let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockWorkflows: ReturnType<typeof signal<SpaceWorkflow[]>>;
let mockSessions: ReturnType<
  typeof signal<{ id: string; title?: string; status: string; lastActiveAt: number }[]>
>;
let mockAgents: ReturnType<typeof signal<{ id: string }[]>>;
let mockRuntimeState: ReturnType<typeof signal<RuntimeState | null>>;

const mockUpdateSpace = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      space: mockSpace,
      loading: mockLoading,
      tasks: mockTasks,
      workflows: mockWorkflows,
      sessions: mockSessions,
      longHorizonAgents: mockAgents,
      runtimeState: mockRuntimeState,
      updateSpace: mockUpdateSpace,
    };
  },
}));

const navigateToSpaceTasksMock = vi.fn();
const navigateToSpaceAgentMock = vi.fn();
const navigateToSpaceSessionsMock = vi.fn();
vi.mock('../../../lib/router', () => ({
  navigateToSpaceTask: vi.fn(),
  navigateToSpaceAgent: (...args: unknown[]) => navigateToSpaceAgentMock(...args),
  navigateToSpaceSession: vi.fn(),
  navigateToSpaceSessions: (...args: unknown[]) => navigateToSpaceSessionsMock(...args),
  navigateToSpaceTasks: (...args: unknown[]) => navigateToSpaceTasksMock(...args),
}));

mockSpace = signal<Space | null>(null);
mockLoading = signal(false);
mockTasks = signal<SpaceTask[]>([]);
mockWorkflows = signal<SpaceWorkflow[]>([]);
mockSessions = signal([]);
mockAgents = signal([]);
mockRuntimeState = signal<RuntimeState | null>(null);

import { SpaceOverview } from '../SpaceOverview';

function makeSpace(overrides: Partial<Space> = {}): Space {
  return {
    id: 'space-1',
    name: 'My Space',
    workspacePath: '/projects/my-space',
    description: '',
    backgroundContext: '',
    autonomyLevel: 1,
    maxConcurrentTasks: 1,
    sessionIds: [],
    status: 'active',
    paused: false,
    stopped: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

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

describe('SpaceOverview', () => {
  beforeEach(() => {
    cleanup();
    mockSpace.value = null;
    mockLoading.value = false;
    mockTasks.value = [];
    mockWorkflows.value = [];
    mockSessions.value = [];
    mockAgents.value = [];
    mockRuntimeState.value = null;
    mockUpdateSpace.mockClear();
    navigateToSpaceTasksMock.mockClear();
    navigateToSpaceAgentMock.mockClear();
    navigateToSpaceSessionsMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders loading spinner when loading', () => {
    mockLoading.value = true;
    const { container } = render(<SpaceOverview spaceId="space-1" />);
    expect(container.querySelector('.animate-spin')).toBeTruthy();
  });

  it('renders "Space not found" when no space', () => {
    const { getByText } = render(<SpaceOverview spaceId="space-1" />);
    expect(getByText('Space not found')).toBeTruthy();
  });

  it('renders Attention/Active/Agents/Sessions stat cards with counts', () => {
    mockSpace.value = makeSpace();
    // Attention = blocked + review (2); Active = open + in_progress + approved (3).
    mockTasks.value = [
      makeTask('t1', 'open'),
      makeTask('t2', 'in_progress'),
      makeTask('t3', 'approved'),
      makeTask('t4', 'blocked'),
      makeTask('t5', 'review'),
      makeTask('t6', 'done'),
    ];
    mockAgents.value = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }];
    mockSessions.value = [{ id: 's1' }];

    const { getByRole, queryByRole } = render(<SpaceOverview spaceId="space-1" />);
    expect(getByRole('button', { name: 'Attention: 2' })).toBeTruthy();
    expect(getByRole('button', { name: 'Active: 3' })).toBeTruthy();
    expect(getByRole('button', { name: 'Agents: 3' })).toBeTruthy();
    expect(getByRole('button', { name: 'Sessions: 1' })).toBeTruthy();
    // The total-Tasks card is intentionally gone.
    expect(queryByRole('button', { name: /^Tasks:/ })).toBeNull();
  });

  it('renders glass controls and flat activity surfaces', () => {
    mockSpace.value = makeSpace();
    mockTasks.value = [makeTask('t1', 'open')];
    mockSessions.value = [
      { id: 'session-1', title: 'Session one', status: 'active', lastActiveAt: Date.now() },
    ];

    const { getByTestId } = render(<SpaceOverview spaceId="space-1" />);
    expect(getByTestId('space-overview-dashboard')).toBeTruthy();
    expect(getByTestId('overview-recent-tasks')).toBeTruthy();
    expect(getByTestId('overview-recent-sessions')).toBeTruthy();
  });

  it('renders recent tasks sorted by updatedAt', () => {
    mockSpace.value = makeSpace();
    const now = Date.now();
    mockTasks.value = [
      makeTask('t1', 'open', { updatedAt: now - 60_000 }),
      makeTask('t2', 'in_progress', { updatedAt: now }),
      makeTask('t3', 'done', { updatedAt: now - 120_000 }),
    ];

    const { getByText } = render(<SpaceOverview spaceId="space-1" />);
    expect(getByText('Recent Tasks')).toBeTruthy();
    expect(getByText('Task t1')).toBeTruthy();
    expect(getByText('Task t2')).toBeTruthy();
    expect(getByText('Task t3')).toBeTruthy();
  });

  it('shows task numbers in recent task items', () => {
    mockSpace.value = makeSpace();
    mockTasks.value = [
      makeTask('task-171', 'open', { title: 'Investigate toolbar state', taskNumber: 171 }),
    ];

    const { getByText } = render(<SpaceOverview spaceId="space-1" />);
    expect(getByText('Investigate toolbar state')).toBeTruthy();
    expect(getByText('#171')).toBeTruthy();
  });

  it('shows empty state when there are no tasks', () => {
    mockSpace.value = makeSpace();
    const { getByText } = render(<SpaceOverview spaceId="space-1" />);
    expect(getByText('No tasks yet')).toBeTruthy();
    expect(getByText('Create a task to get started')).toBeTruthy();
  });

  it('calls onSelectTask when a task row is clicked', () => {
    mockSpace.value = makeSpace();
    mockTasks.value = [makeTask('t1', 'done')];
    const onSelectTask = vi.fn();
    const { getByText } = render(<SpaceOverview spaceId="space-1" onSelectTask={onSelectTask} />);
    fireEvent.click(getByText('Task t1').closest('button')!);
    expect(onSelectTask).toHaveBeenCalledWith('t1');
  });

  it('renders the Create task button in the Recent Tasks header', () => {
    mockSpace.value = makeSpace();
    const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
    expect(getByRole('button', { name: 'Create task' })).toBeTruthy();
  });

  it('clicking Create task opens the Create Task dialog', () => {
    mockSpace.value = makeSpace();
    const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
    fireEvent.click(getByRole('button', { name: 'Create task' }));
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.querySelector('h2')?.textContent).toBe('Create Task');
  });

  it('does not render runtime controls (moved to the header control)', () => {
    // Runtime status + Pause/Stop/Resume now live in SpaceRuntimeStatusControl
    // (rendered in the page header), not in the Overview body.
    mockSpace.value = makeSpace();
    const { queryByText } = render(<SpaceOverview spaceId="space-1" />);
    expect(queryByText('Running')).toBeNull();
    expect(queryByText('Paused')).toBeNull();
  });

  it('limits recent tasks to 5', () => {
    mockSpace.value = makeSpace();
    const now = Date.now();
    mockTasks.value = Array.from({ length: 10 }, (_, i) =>
      makeTask(`t${i + 1}`, 'in_progress', { updatedAt: now - i * 60_000 })
    );

    const { getByTestId } = render(<SpaceOverview spaceId="space-1" />);
    const activityButtons = getByTestId('overview-recent-tasks').querySelectorAll(
      ':scope > div:last-child > button'
    );
    expect(activityButtons.length).toBe(5);
  });

  it('Attention card counts blocked, review, and rate-limited together', () => {
    mockSpace.value = makeSpace();
    mockTasks.value = [makeTask('t1', 'blocked')];
    const { rerender, getByRole } = render(<SpaceOverview spaceId="space-1" />);
    expect(getByRole('button', { name: 'Attention: 1' })).toBeTruthy();

    // review + rate_limited are both in the Attention set (isActionRequired).
    mockTasks.value = [
      makeTask('t1', 'blocked'),
      makeTask('t2', 'review'),
      makeTask('t3', 'rate_limited'),
    ];
    rerender(<SpaceOverview spaceId="space-1" />);
    expect(getByRole('button', { name: 'Attention: 3' })).toBeTruthy();
  });

  it('Attention and Active cards are zero when nothing is actionable or running', () => {
    mockSpace.value = makeSpace();
    mockTasks.value = [makeTask('t1', 'done')];
    const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
    expect(getByRole('button', { name: 'Attention: 0' })).toBeTruthy();
    expect(getByRole('button', { name: 'Active: 0' })).toBeTruthy();
  });

  describe('Autonomy Level Bar', () => {
    it('renders 5 autonomy level segments', () => {
      mockSpace.value = makeSpace({ autonomyLevel: 3 });
      const { container } = render(<SpaceOverview spaceId="space-1" />);
      const segments = container.querySelectorAll('[data-testid^="overview-autonomy-"]');
      expect(segments.length).toBe(5);
    });

    it('shows the current autonomy label', () => {
      mockSpace.value = makeSpace({ autonomyLevel: 3 });
      const { getByText } = render(<SpaceOverview spaceId="space-1" />);
      expect(getByText('Balanced')).toBeTruthy();
    });

    it('calls updateSpace when a different level is clicked', async () => {
      mockSpace.value = makeSpace({ autonomyLevel: 1 });
      const { container } = render(<SpaceOverview spaceId="space-1" />);
      const segment3 = container.querySelector('[data-testid="overview-autonomy-3"]')!;
      await fireEvent.click(segment3);
      expect(mockUpdateSpace).toHaveBeenCalledWith({ autonomyLevel: 3 });
    });

    it('does not call updateSpace when clicking the already-selected level', async () => {
      mockSpace.value = makeSpace({ autonomyLevel: 2 });
      const { container } = render(<SpaceOverview spaceId="space-1" />);
      const segment2 = container.querySelector('[data-testid="overview-autonomy-2"]')!;
      await fireEvent.click(segment2);
      expect(mockUpdateSpace).not.toHaveBeenCalled();
    });

    it('segments have aria-label for accessibility', () => {
      mockSpace.value = makeSpace({ autonomyLevel: 1 });
      const { container } = render(<SpaceOverview spaceId="space-1" />);
      const segment1 = container.querySelector('[data-testid="overview-autonomy-1"]')!;
      expect(segment1.getAttribute('aria-label')).toBe('Supervised');
    });
  });

  describe('Stat Card Navigation', () => {
    beforeEach(() => {
      navigateToSpaceTasksMock.mockClear();
      navigateToSpaceAgentMock.mockClear();
      navigateToSpaceSessionsMock.mockClear();
      mockSpace.value = makeSpace();
      mockTasks.value = [makeTask('t1', 'open'), makeTask('t2', 'review')];
      mockAgents.value = [{ id: 'a1' }];
      mockSessions.value = [{ id: 's1' }];
    });

    it('Attention card navigates to the attention tab', () => {
      const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
      fireEvent.click(getByRole('button', { name: /^Attention:/ }));
      expect(navigateToSpaceTasksMock).toHaveBeenCalledWith('space-1', 'action');
    });

    it('Active card navigates to the active tab', () => {
      const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
      fireEvent.click(getByRole('button', { name: /^Active:/ }));
      expect(navigateToSpaceTasksMock).toHaveBeenCalledWith('space-1', 'active');
    });

    it('uses the route space id for navigation', () => {
      const { getByRole } = render(
        <SpaceOverview spaceId="space-1" navigationSpaceId="space-slug" />
      );
      fireEvent.click(getByRole('button', { name: /^Attention:/ }));
      expect(navigateToSpaceTasksMock).toHaveBeenCalledWith('space-slug', 'action');
    });

    it('Agents card navigates to the Agents page', () => {
      const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
      fireEvent.click(getByRole('button', { name: 'Agents: 1' }));
      expect(navigateToSpaceAgentMock).toHaveBeenCalledWith('space-1');
    });

    it('Sessions card navigates to the Sessions page', () => {
      const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
      fireEvent.click(getByRole('button', { name: 'Sessions: 1' }));
      expect(navigateToSpaceSessionsMock).toHaveBeenCalledWith('space-1');
    });

    it('stat cards have cursor-pointer class', () => {
      const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
      expect(getByRole('button', { name: /^Attention:/ }).className).toContain('cursor-pointer');
      expect(getByRole('button', { name: /^Active:/ }).className).toContain('cursor-pointer');
      expect(getByRole('button', { name: 'Agents: 1' }).className).toContain('cursor-pointer');
      expect(getByRole('button', { name: 'Sessions: 1' }).className).toContain('cursor-pointer');
    });
  });

  describe('Concurrency Bar', () => {
    it('renders concurrency slider with current value', () => {
      mockSpace.value = makeSpace({ maxConcurrentTasks: 3 });
      const { getByTestId, getByText } = render(<SpaceOverview spaceId="space-1" />);
      expect(getByTestId('concurrency-slider')).toBeTruthy();
      expect(getByText('3 tasks')).toBeTruthy();
    });

    it('uses singular "task" when limit is 1', () => {
      mockSpace.value = makeSpace({ maxConcurrentTasks: 1 });
      const { getByText } = render(<SpaceOverview spaceId="space-1" />);
      expect(getByText('1 task')).toBeTruthy();
    });

    it('calls updateSpace when slider value changes', async () => {
      mockSpace.value = makeSpace({ maxConcurrentTasks: 1 });
      const { getByTestId } = render(<SpaceOverview spaceId="space-1" />);
      await fireEvent.change(getByTestId('concurrency-slider'), { target: { value: '5' } });
      expect(mockUpdateSpace).toHaveBeenCalledWith({ maxConcurrentTasks: 5 });
    });

    it('does not call updateSpace when value is unchanged', async () => {
      mockSpace.value = makeSpace({ maxConcurrentTasks: 3 });
      const { getByTestId } = render(<SpaceOverview spaceId="space-1" />);
      await fireEvent.change(getByTestId('concurrency-slider'), { target: { value: '3' } });
      expect(mockUpdateSpace).not.toHaveBeenCalled();
    });
  });
});
