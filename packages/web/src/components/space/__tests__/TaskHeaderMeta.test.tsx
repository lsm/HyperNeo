import type { SpaceGoal, SpaceTask, TaskSchedule } from '@hyperneo/shared';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockGoals, mockSchedules, listSchedules, navigateToSpaceGoals } = vi.hoisted(() => ({
  mockGoals: { value: [] as SpaceGoal[] },
  mockSchedules: { value: [] as TaskSchedule[] },
  listSchedules: vi.fn(async () => []),
  navigateToSpaceGoals: vi.fn(),
}));

vi.mock('../../../lib/space-store', () => ({
  spaceStore: {
    goals: mockGoals,
    schedules: mockSchedules,
    listSchedules,
    fetchEvolutionScope: vi.fn(async () => null),
  },
}));
vi.mock('../../../lib/router', () => ({
  navigateToSpaceGoals,
  navigateToSpaceEvolve: vi.fn(),
}));

import { currentSpaceGoalIdSignal } from '../../../lib/signals';
import { TaskHeaderMeta } from '../TaskHeaderMeta';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    taskNumber: 1,
    title: 'Fix the bug',
    description: '',
    status: 'open',
    priority: 'high',
    dependsOn: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SpaceTask;
}

describe('TaskHeaderMeta', () => {
  afterEach(() => {
    cleanup();
    mockGoals.value = [];
    mockSchedules.value = [];
    listSchedules.mockClear();
  });

  it('shows priority, workspace and a goal link that opens the goal', () => {
    mockGoals.value = [{ id: 'goal-1', title: 'Fast Git panel' } as SpaceGoal];
    const { getByTestId, getByText } = render(
      <TaskHeaderMeta
        task={makeTask({ goalId: 'goal-1' })}
        workspaceLabel="Docs"
        routeSpaceId="space-1"
      />
    );
    expect(getByTestId('task-header-priority').textContent).toBe('High priority');
    expect(getByTestId('task-workspace-badge').textContent).toBe('Docs');

    fireEvent.click(getByText('Goal: Fast Git panel'));

    expect(currentSpaceGoalIdSignal.value).toBe('goal-1');
    expect(navigateToSpaceGoals).toHaveBeenCalledWith('space-1');
  });

  it('loads schedules once when the task came from one that is not loaded yet', () => {
    const task = () => makeTask({ createdByTaskScheduleId: 'sched-1' });
    const { rerender, getByText } = render(<TaskHeaderMeta task={task()} routeSpaceId="space-1" />);
    expect(listSchedules).toHaveBeenCalledTimes(1);

    mockSchedules.value = [{ id: 'sched-1', title: 'Nightly cleanup' } as TaskSchedule];
    rerender(<TaskHeaderMeta task={task()} routeSpaceId="space-1" />);

    expect(getByText('From schedule: Nightly cleanup')).toBeTruthy();
    expect(listSchedules).toHaveBeenCalledTimes(1);
  });
});
