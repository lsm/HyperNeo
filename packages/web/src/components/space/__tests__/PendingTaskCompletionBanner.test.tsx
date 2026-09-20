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

import { PendingTaskCompletionBanner } from '../PendingTaskCompletionBanner';

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

describe('PendingTaskCompletionBanner', () => {
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
      <PendingTaskCompletionBanner task={makeTask({ status: 'in_progress' })} spaceId="space-1" />
    );
    expect(queryByTestId('pending-task-completion-banner')).toBeNull();
  });

  it('renders for a review task whose checkpoint record is missing (#4033)', () => {
    const { getByTestId } = render(
      <PendingTaskCompletionBanner
        task={makeTask({ pendingCheckpointType: null })}
        spaceId="space-1"
      />
    );
    expect(getByTestId('pending-task-completion-approve-btn')).toBeTruthy();
    expect(getByTestId('pending-task-completion-reject-btn')).toBeTruthy();
  });

  it('says the submission record is missing rather than showing a pending-since time', () => {
    const orphan = render(
      <PendingTaskCompletionBanner
        task={makeTask({ pendingCheckpointType: null, pendingCompletionSubmittedAt: null })}
        spaceId="space-1"
      />
    );
    expect(orphan.getByTestId('pending-task-completion-banner').textContent).toContain(
      'submission record missing'
    );
    cleanup();

    const healthy = render(
      <PendingTaskCompletionBanner
        task={makeTask({ pendingCompletionSubmittedAt: Date.now() - 5000 })}
        spaceId="space-1"
      />
    );
    const text = healthy.getByTestId('pending-task-completion-banner').textContent;
    expect(text).toContain('5s ago');
    expect(text).not.toContain('submission record missing');
  });

  it('approves an orphaned review task through the same operation', async () => {
    const { getByTestId } = render(
      <PendingTaskCompletionBanner
        task={makeTask({ pendingCheckpointType: null })}
        spaceId="space-1"
      />
    );
    fireEvent.click(getByTestId('pending-task-completion-approve-btn'));
    fireEvent.click(getByTestId('pending-task-completion-approve-confirm'));

    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('task-1', true, null));
  });

  it('sends an orphaned review task back with its reason', async () => {
    const { getByTestId } = render(
      <PendingTaskCompletionBanner
        task={makeTask({ pendingCheckpointType: null })}
        spaceId="space-1"
      />
    );
    fireEvent.click(getByTestId('pending-task-completion-reject-btn'));
    fireEvent.input(getByTestId('pending-task-completion-reject-reason'), {
      target: { value: '  not done  ' },
    });
    fireEvent.click(getByTestId('pending-task-completion-reject-confirm'));

    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('task-1', false, 'not done'));
  });

  it('surfaces a rejection from the daemon instead of failing silently', async () => {
    approveMock.mockRejectedValue(new Error('not awaiting submit_for_approval review'));
    const { getByTestId } = render(
      <PendingTaskCompletionBanner
        task={makeTask({ pendingCheckpointType: null })}
        spaceId="space-1"
      />
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
