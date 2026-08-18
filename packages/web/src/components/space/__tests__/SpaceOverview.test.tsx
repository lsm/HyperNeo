// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { RuntimeState, Space, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';

let mockSpace: ReturnType<typeof signal<Space | null>>;
let mockLoading: ReturnType<typeof signal<boolean>>;
let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockWorkflows: ReturnType<typeof signal<SpaceWorkflow[]>>;
let mockRuntimeState: ReturnType<typeof signal<RuntimeState | null>>;
let mockSessions: ReturnType<
  typeof signal<{ id: string; title?: string; status: string; lastActiveAt: number }[]>
>;

const mockPauseSpace = vi.fn().mockResolvedValue(undefined);
const mockResumeSpace = vi.fn().mockResolvedValue(undefined);
const mockStopSpace = vi.fn().mockResolvedValue(undefined);
const mockStartSpace = vi.fn().mockResolvedValue(undefined);
const mockUpdateSpace = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      space: mockSpace,
      loading: mockLoading,
      tasks: mockTasks,
      workflows: mockWorkflows,
      runtimeState: mockRuntimeState,
      sessions: mockSessions,
      pauseSpace: mockPauseSpace,
      resumeSpace: mockResumeSpace,
      stopSpace: mockStopSpace,
      startSpace: mockStartSpace,
      updateSpace: mockUpdateSpace,
    };
  },
}));

const navigateToSpaceTasksMock = vi.fn();
vi.mock('../../../lib/router', () => ({
  navigateToSpaceTask: vi.fn(),
  navigateToSpaceAgent: vi.fn(),
  navigateToSpaceSession: vi.fn(),
  navigateToSpaceTasks: (...args: unknown[]) => navigateToSpaceTasksMock(...args),
}));

mockSpace = signal<Space | null>(null);
mockLoading = signal(false);
mockTasks = signal<SpaceTask[]>([]);
mockWorkflows = signal<SpaceWorkflow[]>([]);
mockRuntimeState = signal<RuntimeState | null>(null);
mockSessions = signal([]);

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
    mockRuntimeState.value = null;
    mockSessions.value = [];
    mockPauseSpace.mockClear();
    mockResumeSpace.mockClear();
    mockStopSpace.mockClear();
    mockStartSpace.mockClear();
    mockUpdateSpace.mockClear();
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

  it('renders stat cards with correct counts', () => {
    mockSpace.value = makeSpace();
    mockTasks.value = [
      makeTask('t1', 'open'),
      makeTask('t2', 'in_progress'),
      makeTask('t3', 'blocked'),
      makeTask('t4', 'done'),
    ];

    const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
    expect(getByRole('button', { name: 'Active tasks: 2' })).toBeTruthy();
    expect(getByRole('button', { name: 'Review tasks: 1' })).toBeTruthy();
    expect(getByRole('button', { name: 'Done tasks: 1' })).toBeTruthy();
  });

  it('renders glass controls and flat activity surfaces', () => {
    mockSpace.value = makeSpace();
    mockRuntimeState.value = 'running';
    mockTasks.value = [makeTask('t1', 'open')];
    mockSessions.value = [
      { id: 'session-1', title: 'Session one', status: 'active', lastActiveAt: Date.now() },
    ];

    const { getByTestId, getByText } = render(<SpaceOverview spaceId="space-1" />);

    expect(getByTestId('space-overview-dashboard')).toBeTruthy();
    expect(getByTestId('overview-recent-tasks')).toBeTruthy();
    expect(getByTestId('overview-recent-sessions')).toBeTruthy();
    expect(getByText('Running').closest('.backdrop-blur-xl')).toBeTruthy();
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

  it('renders the Create Task button', () => {
    mockSpace.value = makeSpace();
    const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
    expect(getByRole('button', { name: 'Create Task' })).toBeTruthy();
  });

  it('clicking Create Task button opens the Create Task dialog', () => {
    mockSpace.value = makeSpace();
    const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
    fireEvent.click(getByRole('button', { name: 'Create Task' }));
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.querySelector('h2')?.textContent).toBe('Create Task');
  });

  it('renders runtime control bar when runtimeState is set', () => {
    mockSpace.value = makeSpace();
    mockRuntimeState.value = 'running';
    const { getByText } = render(<SpaceOverview spaceId="space-1" />);
    expect(getByText('Running')).toBeTruthy();
  });

  it('does not render runtime control bar when runtimeState is null', () => {
    mockSpace.value = makeSpace();
    mockRuntimeState.value = null;
    const { queryByText } = render(<SpaceOverview spaceId="space-1" />);
    expect(queryByText('Running')).toBeNull();
    expect(queryByText('Paused')).toBeNull();
    expect(queryByText('Stopped')).toBeNull();
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

  it('stat card counts update when tasks change', () => {
    mockSpace.value = makeSpace();
    mockTasks.value = [makeTask('t1', 'open')];

    const { container, rerender } = render(<SpaceOverview spaceId="space-1" />);

    const getStatText = () =>
      Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    let stats = getStatText();
    expect(stats.some((t) => t?.includes('Active') && t?.includes('1'))).toBe(true);
    expect(stats.some((t) => t?.includes('Review') && t?.includes('0'))).toBe(true);

    mockTasks.value = [makeTask('t1', 'open'), makeTask('t2', 'blocked')];
    rerender(<SpaceOverview spaceId="space-1" />);

    stats = getStatText();
    expect(stats.some((t) => t?.includes('Active') && t?.includes('1'))).toBe(true);
    expect(stats.some((t) => t?.includes('Review') && t?.includes('1'))).toBe(true);
  });

  describe('Runtime State Indicator', () => {
    it('shows running state with green indicator and ping animation', () => {
      mockSpace.value = makeSpace();
      mockRuntimeState.value = 'running';
      const { container, getByText } = render(<SpaceOverview spaceId="space-1" />);
      expect(getByText('Running')).toBeTruthy();
      expect(container.querySelector('.bg-green-400')).toBeTruthy();
      expect(container.querySelector('.animate-ping')).toBeTruthy();
    });

    it('shows paused state with yellow indicator and no ping', () => {
      mockSpace.value = makeSpace();
      mockRuntimeState.value = 'paused';
      const { container, getByText } = render(<SpaceOverview spaceId="space-1" />);
      expect(getByText('Paused')).toBeTruthy();
      expect(container.querySelector('.bg-yellow-400')).toBeTruthy();
      expect(container.querySelector('.animate-ping')).toBeFalsy();
    });

    it('shows stopped state with gray indicator', () => {
      mockSpace.value = makeSpace();
      mockRuntimeState.value = 'stopped';
      const { container, getByText } = render(<SpaceOverview spaceId="space-1" />);
      expect(getByText('Stopped')).toBeTruthy();
      expect(container.querySelector('.bg-gray-500')).toBeTruthy();
    });
  });

  describe('Runtime Control Buttons', () => {
    it('shows Pause and Stop buttons when running, no Resume button', () => {
      mockSpace.value = makeSpace();
      mockRuntimeState.value = 'running';
      const { container } = render(<SpaceOverview spaceId="space-1" />);
      const buttons = Array.from(container.querySelectorAll('button'));
      expect(buttons.find((b) => b.textContent === 'Pause')).toBeTruthy();
      expect(buttons.find((b) => b.textContent === 'Stop')).toBeTruthy();
      expect(buttons.find((b) => b.textContent === 'Resume')).toBeFalsy();
    });

    it('shows Resume and Stop buttons when paused, no Pause button', () => {
      mockSpace.value = makeSpace();
      mockRuntimeState.value = 'paused';
      const { container } = render(<SpaceOverview spaceId="space-1" />);
      const buttons = Array.from(container.querySelectorAll('button'));
      expect(buttons.find((b) => b.textContent === 'Resume')).toBeTruthy();
      expect(buttons.find((b) => b.textContent === 'Stop')).toBeTruthy();
      expect(buttons.find((b) => b.textContent === 'Pause')).toBeFalsy();
    });

    it('shows Start button when stopped, no Pause/Resume/Stop buttons', () => {
      mockSpace.value = makeSpace();
      mockRuntimeState.value = 'stopped';
      const { container } = render(<SpaceOverview spaceId="space-1" />);
      const buttons = Array.from(container.querySelectorAll('button'));
      expect(buttons.find((b) => b.textContent === 'Start')).toBeTruthy();
      expect(buttons.find((b) => b.textContent === 'Pause')).toBeFalsy();
      expect(buttons.find((b) => b.textContent === 'Resume')).toBeFalsy();
      expect(buttons.find((b) => b.textContent === 'Stop')).toBeFalsy();
    });

    it('calls pauseSpace when Pause is clicked', async () => {
      mockSpace.value = makeSpace();
      mockRuntimeState.value = 'running';
      const { container } = render(<SpaceOverview spaceId="space-1" />);
      const pauseBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Pause'
      )!;
      await fireEvent.click(pauseBtn);
      expect(mockPauseSpace).toHaveBeenCalledTimes(1);
    });

    it('calls resumeSpace when Resume is clicked', async () => {
      mockSpace.value = makeSpace();
      mockRuntimeState.value = 'paused';
      const { container } = render(<SpaceOverview spaceId="space-1" />);
      const resumeBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Resume'
      )!;
      await fireEvent.click(resumeBtn);
      expect(mockResumeSpace).toHaveBeenCalledTimes(1);
    });

    it('opens stop confirmation dialog when Stop is clicked while running', () => {
      mockSpace.value = makeSpace();
      mockRuntimeState.value = 'running';
      const { container } = render(<SpaceOverview spaceId="space-1" />);
      const stopBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Stop'
      )!;
      fireEvent.click(stopBtn);
      const dialog = document.body.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog?.querySelector('h2')?.textContent).toBe('Stop Space');
    });

    it('calls stopSpace when Stop is confirmed', async () => {
      mockSpace.value = makeSpace();
      mockRuntimeState.value = 'running';
      const { container } = render(<SpaceOverview spaceId="space-1" />);
      const stopBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Stop'
      )!;
      fireEvent.click(stopBtn);
      const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent === 'Stop Space'
      )!;
      await fireEvent.click(confirmBtn);
      expect(mockStopSpace).toHaveBeenCalledTimes(1);
    });

    it('calls startSpace when Start is clicked while stopped', async () => {
      mockSpace.value = makeSpace();
      mockRuntimeState.value = 'stopped';
      const { container } = render(<SpaceOverview spaceId="space-1" />);
      const startBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Start'
      )!;
      await fireEvent.click(startBtn);
      expect(mockStartSpace).toHaveBeenCalledTimes(1);
    });
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
      mockSpace.value = makeSpace();
      mockTasks.value = [
        makeTask('t1', 'open'),
        makeTask('t2', 'in_progress'),
        makeTask('t3', 'review'),
        makeTask('t4', 'done'),
        makeTask('t5', 'archived'),
      ];
    });

    it('clicking Active stat card navigates to tasks with active tab', () => {
      const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
      fireEvent.click(getByRole('button', { name: 'Active tasks: 2' }));
      expect(navigateToSpaceTasksMock).toHaveBeenCalledWith('space-1', 'active');
    });

    it('uses the route space id for stat card navigation', () => {
      const { getByRole } = render(
        <SpaceOverview spaceId="space-1" navigationSpaceId="space-slug" />
      );
      fireEvent.click(getByRole('button', { name: 'Active tasks: 2' }));
      expect(navigateToSpaceTasksMock).toHaveBeenCalledWith('space-slug', 'active');
    });

    it('clicking Review stat card navigates to tasks with action tab', () => {
      const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
      fireEvent.click(getByRole('button', { name: 'Review tasks: 1' }));
      expect(navigateToSpaceTasksMock).toHaveBeenCalledWith('space-1', 'action');
    });

    it('clicking Done stat card navigates to tasks with completed tab', () => {
      const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
      fireEvent.click(getByRole('button', { name: 'Done tasks: 2' }));
      expect(navigateToSpaceTasksMock).toHaveBeenCalledWith('space-1', 'completed');
    });

    it('Done count includes archived tasks to match the completed tab', () => {
      const { container } = render(<SpaceOverview spaceId="space-1" />);
      const doneBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Done')
      )!;
      expect(doneBtn.textContent).toContain('2');
    });

    it('stat cards have cursor-pointer class', () => {
      const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
      expect(getByRole('button', { name: 'Active tasks: 2' }).className).toContain(
        'cursor-pointer'
      );
      expect(getByRole('button', { name: 'Review tasks: 1' }).className).toContain(
        'cursor-pointer'
      );
      expect(getByRole('button', { name: 'Done tasks: 2' }).className).toContain('cursor-pointer');
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
