import type { TaskMilestoneRow } from '@hyperneo/shared';
import { render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';

const mockUseTaskMilestones = vi.fn();

vi.mock('../../../hooks/useTaskMilestones', () => ({
  useTaskMilestones: (args: unknown) => mockUseTaskMilestones(args),
}));

import { TaskMilestoneTimeline } from '../TaskMilestoneTimeline';

function milestone(
  partial: Partial<TaskMilestoneRow> & Pick<TaskMilestoneRow, 'id'>
): TaskMilestoneRow {
  return {
    taskId: 'task-1',
    category: 'answer',
    tone: 'neutral',
    title: 'x',
    body: null,
    sourceLabel: null,
    sourceKind: null,
    sourceId: null,
    createdAt: Date.now(),
    ...partial,
  };
}

describe('TaskMilestoneTimeline', () => {
  it('renders real milestone content (not generic actor-message labels)', () => {
    mockUseTaskMilestones.mockReturnValue({
      rows: [
        milestone({
          id: 'c',
          category: 'creation',
          tone: 'info',
          title: 'Task created',
          createdAt: 1000,
        }),
        milestone({
          id: 'a',
          category: 'answer',
          tone: 'neutral',
          title: 'Answer',
          body: 'Opened PR #42 and wired the tests',
          sourceLabel: 'coder',
          createdAt: 2000,
        }),
      ],
      isLoading: false,
      isReconnecting: false,
    });

    render(<TaskMilestoneTimeline taskId="task-1" />);

    expect(screen.getByText('Task created')).toBeTruthy();
    expect(screen.getByText('Opened PR #42 and wired the tests')).toBeTruthy();
    expect(screen.getByText('coder')).toBeTruthy();
  });

  it('collapses a consecutive retry burst into a single row', () => {
    mockUseTaskMilestones.mockReturnValue({
      rows: [
        milestone({
          id: 'r1',
          category: 'retry',
          tone: 'warning',
          title: 'API retry',
          body: 'Attempt 1/10 · status 529',
          createdAt: 1000,
        }),
        milestone({
          id: 'r2',
          category: 'retry',
          tone: 'warning',
          title: 'API retry',
          body: 'Attempt 2/10 · status 529',
          createdAt: 2000,
        }),
        milestone({
          id: 'r3',
          category: 'retry',
          tone: 'warning',
          title: 'API retry',
          body: 'Attempt 3/10 · status 529',
          createdAt: 3000,
        }),
      ],
      isLoading: false,
      isReconnecting: false,
    });

    render(<TaskMilestoneTimeline taskId="task-1" />);

    const rows = screen.getAllByTestId('task-milestone-row');
    expect(rows).toHaveLength(1);
    expect(screen.getByText('API retried 3×')).toBeTruthy();
  });

  it('shows the empty state when there are no milestones', () => {
    mockUseTaskMilestones.mockReturnValue({ rows: [], isLoading: false, isReconnecting: false });
    render(<TaskMilestoneTimeline taskId="task-1" />);
    expect(screen.getByText('No task timeline events yet.')).toBeTruthy();
  });

  it('shows the loading state while the feed loads', () => {
    mockUseTaskMilestones.mockReturnValue({ rows: [], isLoading: true, isReconnecting: false });
    render(<TaskMilestoneTimeline taskId="task-1" />);
    expect(screen.getByText('Loading task timeline…')).toBeTruthy();
  });
});
