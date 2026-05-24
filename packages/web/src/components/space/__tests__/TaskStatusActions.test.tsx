// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach } from 'vitest';
import type { SpaceTaskStatus } from '@neokai/shared';
import {
  TaskStatusActions,
  getTransitionActions,
  VALID_TASK_TRANSITIONS,
  TRANSITION_LABELS,
} from '../TaskStatusActions';

afterEach(() => {
  cleanup();
});

describe('VALID_TASK_TRANSITIONS', () => {
  it('open can transition to in_progress, blocked, review, done, and cancelled', () => {
    expect(VALID_TASK_TRANSITIONS.open).toEqual([
      'in_progress',
      'blocked',
      'review',
      'done',
      'cancelled',
    ]);
  });

  it('in_progress can transition to open, review, done, blocked, cancelled', () => {
    expect(VALID_TASK_TRANSITIONS.in_progress).toEqual([
      'open',
      'review',
      'done',
      'blocked',
      'cancelled',
    ]);
  });

  it('done can transition to in_progress and archived', () => {
    expect(VALID_TASK_TRANSITIONS.done).toEqual(['in_progress', 'archived']);
  });

  it('blocked can transition to open, in_progress, review, cancelled, archived', () => {
    expect(VALID_TASK_TRANSITIONS.blocked).toEqual([
      'open',
      'in_progress',
      'review',
      'cancelled',
      'archived',
    ]);
  });

  it('cancelled can transition to open, in_progress, done, archived', () => {
    expect(VALID_TASK_TRANSITIONS.cancelled).toEqual(['open', 'in_progress', 'done', 'archived']);
  });

  it('archived has no transitions', () => {
    expect(VALID_TASK_TRANSITIONS.archived).toEqual([]);
  });
});

describe('getTransitionActions', () => {
  it('returns correct actions for open status', () => {
    const actions = getTransitionActions('open');
    expect(actions).toEqual([
      { target: 'in_progress', label: 'Start' },
      { target: 'blocked', label: 'Block' },
      { target: 'review', label: 'Submit for Review' },
      { target: 'done', label: 'Mark Done' },
      { target: 'cancelled', label: 'Cancel' },
    ]);
  });

  it('returns correct actions for in_progress status', () => {
    const actions = getTransitionActions('in_progress');
    expect(actions).toEqual([
      { target: 'open', label: 'Pause' },
      { target: 'review', label: 'Submit for Review' },
      { target: 'done', label: 'Mark Done' },
      { target: 'blocked', label: 'Block' },
      { target: 'cancelled', label: 'Cancel' },
    ]);
  });

  it('returns correct actions for done status', () => {
    const actions = getTransitionActions('done');
    expect(actions).toEqual([
      { target: 'in_progress', label: 'Reopen' },
      { target: 'archived', label: 'Archive' },
    ]);
  });

  it('returns correct actions for blocked status', () => {
    const actions = getTransitionActions('blocked');
    expect(actions).toEqual([
      { target: 'open', label: 'Reopen' },
      { target: 'in_progress', label: 'Resume' },
      { target: 'review', label: 'Submit for Review' },
      { target: 'cancelled', label: 'Cancel' },
      { target: 'archived', label: 'Archive' },
    ]);
  });

  it('returns correct actions for cancelled status', () => {
    const actions = getTransitionActions('cancelled');
    expect(actions).toEqual([
      { target: 'open', label: 'Reopen' },
      { target: 'in_progress', label: 'Resume' },
      { target: 'done', label: 'Mark Done' },
      { target: 'archived', label: 'Archive' },
    ]);
  });

  it('returns empty array for archived status', () => {
    expect(getTransitionActions('archived')).toEqual([]);
  });
});

describe('TRANSITION_LABELS', () => {
  it('has a label for every valid transition', () => {
    for (const [from, targets] of Object.entries(VALID_TASK_TRANSITIONS)) {
      for (const to of targets) {
        const key = `${from}->${to}`;
        expect(TRANSITION_LABELS[key]).toBeDefined();
        expect(typeof TRANSITION_LABELS[key]).toBe('string');
      }
    }
  });
});

describe('TaskStatusActions component', () => {
  const allStatuses: SpaceTaskStatus[] = [
    'open',
    'in_progress',
    'done',
    'blocked',
    'cancelled',
    'archived',
  ];

  it.each(allStatuses)('renders correct buttons for %s status', (status) => {
    const onTransition = vi.fn();
    const { container } = render(<TaskStatusActions status={status} onTransition={onTransition} />);
    const expectedActions = getTransitionActions(status);
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(expectedActions.length);
    for (let i = 0; i < expectedActions.length; i++) {
      expect(buttons[i].textContent).toBe(expectedActions[i].label);
    }
  });

  it('shows no-actions message for archived status', () => {
    const onTransition = vi.fn();
    const { getByTestId } = render(
      <TaskStatusActions status="archived" onTransition={onTransition} />
    );
    expect(getByTestId('task-status-no-actions').textContent).toBe('No status actions available.');
  });

  it('calls onTransition with target status when button clicked', () => {
    const onTransition = vi.fn();
    const { getByTestId } = render(<TaskStatusActions status="open" onTransition={onTransition} />);
    fireEvent.click(getByTestId('task-action-in_progress'));
    expect(onTransition).toHaveBeenCalledWith('in_progress');
  });

  it('calls onTransition with cancelled when Cancel clicked on in_progress', () => {
    const onTransition = vi.fn();
    const { getByTestId } = render(
      <TaskStatusActions status="in_progress" onTransition={onTransition} />
    );
    fireEvent.click(getByTestId('task-action-cancelled'));
    expect(onTransition).toHaveBeenCalledWith('cancelled');
  });

  it('disables all buttons when disabled prop is true', () => {
    const onTransition = vi.fn();
    const { container } = render(
      <TaskStatusActions status="in_progress" onTransition={onTransition} disabled={true} />
    );
    const buttons = container.querySelectorAll('button');
    for (const btn of buttons) {
      expect(btn.disabled).toBe(true);
    }
  });

  it('buttons are enabled by default', () => {
    const onTransition = vi.fn();
    const { container } = render(
      <TaskStatusActions status="blocked" onTransition={onTransition} />
    );
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) {
      expect(btn.disabled).toBe(false);
    }
  });

  it('renders data-testid for each action button', () => {
    const onTransition = vi.fn();
    const { getByTestId } = render(<TaskStatusActions status="done" onTransition={onTransition} />);
    expect(getByTestId('task-action-in_progress')).toBeTruthy();
    expect(getByTestId('task-action-archived')).toBeTruthy();
  });

  it('renders actions container with data-testid', () => {
    const onTransition = vi.fn();
    const { getByTestId } = render(<TaskStatusActions status="open" onTransition={onTransition} />);
    expect(getByTestId('task-status-actions')).toBeTruthy();
  });

  describe('pendingCheckpointType gating', () => {
    it('hides Approve (done) and Cancel (cancelled) when paused at a submit_for_approval checkpoint', () => {
      const onTransition = vi.fn();
      const { queryByTestId, getByTestId } = render(
        <TaskStatusActions
          status="review"
          onTransition={onTransition}
          pendingCheckpointType="task_completion"
        />
      );
      // "review -> done" / "review -> cancelled" are owned by the banner now
      expect(queryByTestId('task-action-done')).toBeNull();
      expect(queryByTestId('task-action-cancelled')).toBeNull();
      // Non-approval transitions stay visible so the user can still reopen or archive.
      expect(getByTestId('task-action-in_progress')).toBeTruthy();
      expect(getByTestId('task-action-archived')).toBeTruthy();
    });

    it('hides Approve / Cancel for any review task even when pendingCheckpointType is null', () => {
      // After unification (Task #123) every fresh `review` task carries
      // `pendingCheckpointType === 'task_completion'` because the unified
      // `submitTaskForReview` helper stamps it on transition. Legacy data
      // from before unification (null checkpoint type, status=review) must
      // still route through the banner — the bare review→done button would
      // bypass `PostApprovalRouter` and the approval-metadata stamp. So
      // we hide the generic Approve/Cancel buttons whenever status==='review'
      // regardless of `pendingCheckpointType`.
      const onTransition = vi.fn();
      const { queryByTestId, getByTestId } = render(
        <TaskStatusActions
          status="review"
          onTransition={onTransition}
          pendingCheckpointType={null}
        />
      );
      expect(queryByTestId('task-action-done')).toBeNull();
      expect(queryByTestId('task-action-cancelled')).toBeNull();
      // Non-approval escape hatches stay visible.
      expect(getByTestId('task-action-in_progress')).toBeTruthy();
      expect(getByTestId('task-action-archived')).toBeTruthy();
    });

    it('hides Approve (done) and Cancel (cancelled) when paused at gate approval', () => {
      const onTransition = vi.fn();
      const { queryByTestId, getByTestId } = render(
        <TaskStatusActions
          status="review"
          onTransition={onTransition}
          pendingCheckpointType="gate"
        />
      );
      // PendingGateBanner owns the approval UX for gate-pending tasks;
      // the generic buttons must not be visible to prevent bypassing the gate.
      expect(queryByTestId('task-action-done')).toBeNull();
      expect(queryByTestId('task-action-cancelled')).toBeNull();
      // Non-approval transitions stay visible.
      expect(getByTestId('task-action-in_progress')).toBeTruthy();
      expect(getByTestId('task-action-archived')).toBeTruthy();
    });
  });
});
