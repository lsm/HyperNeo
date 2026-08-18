// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import type { SpaceTask } from '@hyperneo/shared';

const updateTaskMock: Mock = vi.fn();
vi.mock('../../../lib/space-store', () => ({
  spaceStore: {
    updateTask: (...args: unknown[]) => updateTaskMock(...args),
  },
}));

import { PendingPostApprovalBanner } from '../PendingPostApprovalBanner';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    title: 'T',
    description: '',
    status: 'approved',
    dependsOn: [],
    assignedToSessionId: null,
    reportedByAgentName: null,
    result: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SpaceTask;
}

describe('PendingPostApprovalBanner', () => {
  beforeEach(() => {
    cleanup();
    updateTaskMock.mockReset();
    updateTaskMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
  });

  it('hidden when task status is not approved', () => {
    const task = makeTask({ status: 'in_progress', postApprovalBlockedReason: 'failure' });
    const { queryByTestId } = render(<PendingPostApprovalBanner task={task} spaceId="space-1" />);
    expect(queryByTestId('pending-post-approval-banner')).toBeNull();
  });

  it('hidden when approved but no blocked reason', () => {
    const task = makeTask({ status: 'approved', postApprovalBlockedReason: null });
    const { queryByTestId } = render(<PendingPostApprovalBanner task={task} spaceId="space-1" />);
    expect(queryByTestId('pending-post-approval-banner')).toBeNull();
  });

  it('renders reason + Send back + Mark done when blocked', () => {
    const task = makeTask({
      status: 'approved',
      postApprovalBlockedReason: 'deploy session crashed',
    });
    const { getByTestId, queryByTestId } = render(
      <PendingPostApprovalBanner task={task} spaceId="space-1" />
    );
    const banner = getByTestId('pending-post-approval-banner');
    expect(banner.textContent).toContain('deploy session crashed');
    expect(queryByTestId('pending-post-approval-send-back-btn')).not.toBeNull();
    expect(queryByTestId('pending-post-approval-mark-done-btn')).not.toBeNull();
    expect(queryByTestId('pending-post-approval-view-session-btn')).toBeNull();
  });

  it('Send back calls updateTask with status=in_progress', async () => {
    const task = makeTask({
      status: 'approved',
      postApprovalBlockedReason: 'spawn failed',
    });
    const { getByTestId } = render(<PendingPostApprovalBanner task={task} spaceId="space-1" />);
    fireEvent.click(getByTestId('pending-post-approval-send-back-btn'));
    await waitFor(() => {
      expect(updateTaskMock).toHaveBeenCalledTimes(1);
    });
    expect(updateTaskMock).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'in_progress', postApprovalBlockedReason: null })
    );
  });

  it('Mark done calls updateTask with status=done and clears post-approval fields', async () => {
    const task = makeTask({
      status: 'approved',
      postApprovalBlockedReason: 'stuck',
    });
    const { getByTestId } = render(<PendingPostApprovalBanner task={task} spaceId="space-1" />);
    fireEvent.click(getByTestId('pending-post-approval-mark-done-btn'));
    await waitFor(() => {
      expect(updateTaskMock).toHaveBeenCalledTimes(1);
    });
    expect(updateTaskMock).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'done',
        postApprovalSessionId: null,
        postApprovalStartedAt: null,
        postApprovalBlockedReason: null,
      })
    );
  });

  it('View session appears when sessionId + handler present', () => {
    const task = makeTask({
      status: 'approved',
      postApprovalBlockedReason: 'stuck',
      postApprovalSessionId: 'session-xyz',
    });
    const onViewSession: Mock = vi.fn();
    const { getByTestId } = render(
      <PendingPostApprovalBanner task={task} spaceId="space-1" onViewSession={onViewSession} />
    );
    const btn = getByTestId('pending-post-approval-view-session-btn');
    fireEvent.click(btn);
    expect(onViewSession).toHaveBeenCalledWith('session-xyz');
  });

  it('surfaces error when updateTask rejects', async () => {
    updateTaskMock.mockRejectedValueOnce(new Error('rpc exploded'));
    const task = makeTask({
      status: 'approved',
      postApprovalBlockedReason: 'stuck',
    });
    const { getByTestId } = render(<PendingPostApprovalBanner task={task} spaceId="space-1" />);
    fireEvent.click(getByTestId('pending-post-approval-mark-done-btn'));
    await waitFor(() => {
      expect(getByTestId('pending-post-approval-error').textContent).toContain('rpc exploded');
    });
  });
});
