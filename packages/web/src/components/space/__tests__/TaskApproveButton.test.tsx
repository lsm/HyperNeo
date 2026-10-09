// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import type { SpaceTask } from '@hyperneo/shared';

const approveMock: Mock = vi.fn();
vi.mock('../../../lib/space-store', () => ({
  spaceStore: {
    approvePendingCompletion: (...args: unknown[]) => approveMock(...args),
  },
}));

import { TaskApproveButton } from '../TaskApproveButton';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    title: 'T',
    description: '',
    status: 'review',
    dependsOn: [],
    assignedToSessionId: null,
    reportedByAgentName: null,
    result: null,
    pendingCheckpointType: 'task_completion',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SpaceTask;
}

describe('TaskApproveButton', () => {
  beforeEach(() => {
    cleanup();
    approveMock.mockReset();
    approveMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
  });

  it('hidden when the task is not in review', () => {
    const { queryByTestId } = render(
      <TaskApproveButton task={makeTask({ status: 'in_progress' })} spaceId="space-1" />
    );
    expect(queryByTestId('pending-task-completion-banner')).toBeNull();
  });

  it('renders for a review task whose checkpoint record is missing (#4033)', () => {
    const { getByTestId } = render(
      <TaskApproveButton task={makeTask({ pendingCheckpointType: null })} />
    );
    expect(getByTestId('pending-task-completion-approve-btn')).toBeTruthy();
  });

  it('approves an orphaned review task through the same operation', async () => {
    const { getByTestId } = render(
      <TaskApproveButton task={makeTask({ pendingCheckpointType: null })} />
    );
    fireEvent.click(getByTestId('pending-task-completion-approve-btn'));
    fireEvent.click(getByTestId('pending-task-completion-approve-confirm'));

    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('task-1', true, null));
  });

  it('surfaces a rejection from the daemon instead of failing silently', async () => {
    approveMock.mockRejectedValue(new Error('not awaiting submit_for_approval review'));
    const { getByTestId } = render(
      <TaskApproveButton task={makeTask({ pendingCheckpointType: null })} />
    );
    fireEvent.click(getByTestId('pending-task-completion-approve-btn'));
    fireEvent.click(getByTestId('pending-task-completion-approve-confirm'));

    await waitFor(() =>
      expect(getByTestId('pending-task-completion-error').textContent).toContain(
        'not awaiting submit_for_approval review'
      )
    );
  });
});
