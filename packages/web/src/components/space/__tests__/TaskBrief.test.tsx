import type { SpaceGoal, SpaceTask } from '@hyperneo/shared';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockGoals, navigateToSpaceGoals } = vi.hoisted(() => ({
  mockGoals: { value: [] as SpaceGoal[] },
  navigateToSpaceGoals: vi.fn(),
}));

vi.mock('../../../lib/space-store', () => ({
  spaceStore: {
    goals: mockGoals,
    schedules: signal([]),
    fetchEvolutionScope: vi.fn(async () => null),
  },
}));
vi.mock('../../../lib/router', () => ({
  navigateToSpaceGoals,
  navigateToSpaceEvolve: vi.fn(),
}));

import { currentSpaceGoalIdSignal } from '../../../lib/signals';
import { TaskBrief } from '../TaskBrief';

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
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SpaceTask;
}

const LONG = 'Batch the per-file diffs into one call per range. '.repeat(6);

describe('TaskBrief', () => {
  afterEach(() => {
    cleanup();
    mockGoals.value = [];
  });

  it('clamps a long brief when collapsible and expands it on demand', () => {
    const { getByTestId } = render(
      <TaskBrief task={makeTask()} description={LONG} routeSpaceId="space-1" collapsible />
    );
    expect(getByTestId('task-brief-text').className).toContain('line-clamp-2');

    fireEvent.click(getByTestId('task-brief-toggle'));

    expect(getByTestId('task-brief-text').className).not.toContain('line-clamp-2');
    expect(getByTestId('task-brief-toggle').textContent).toBe('Show less');
  });

  it('shows the whole brief without a toggle when not collapsible', () => {
    const { getByTestId, queryByTestId } = render(
      <TaskBrief task={makeTask()} description={LONG} routeSpaceId="space-1" />
    );
    expect(getByTestId('task-brief-text').className).not.toContain('line-clamp-2');
    expect(queryByTestId('task-brief-toggle')).toBeNull();
  });

  it('shows priority, workspace and a goal link that opens the goal', () => {
    mockGoals.value = [{ id: 'goal-1', title: 'Fast Git panel' } as SpaceGoal];
    const { getByTestId, getByText } = render(
      <TaskBrief
        task={makeTask({ goalId: 'goal-1' })}
        description="Short"
        workspaceLabel="Docs"
        routeSpaceId="space-1"
      />
    );
    expect(getByTestId('task-brief-priority').textContent).toBe('High priority');
    expect(getByTestId('task-workspace-badge').textContent).toBe('Docs');

    fireEvent.click(getByText('Goal: Fast Git panel'));

    expect(currentSpaceGoalIdSignal.value).toBe('goal-1');
    expect(navigateToSpaceGoals).toHaveBeenCalledWith('space-1');
  });
});
