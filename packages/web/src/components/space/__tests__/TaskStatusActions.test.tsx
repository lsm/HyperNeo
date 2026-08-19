// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach } from 'vitest';
import type { SpaceTaskStatus } from '@hyperneo/shared';
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
  it('open can transition to in_progress, blocked, review, done, cancelled, and archived', () => {
    expect(VALID_TASK_TRANSITIONS.open).toEqual([
      'in_progress',
      'blocked',
      'review',
      'done',
      'cancelled',
      'archived',
    ]);
  });

  it('in_progress can transition to review, done, blocked, cancelled, stopped', () => {
    expect(VALID_TASK_TRANSITIONS.in_progress).toEqual([
      'review',
      'done',
      'blocked',
      'cancelled',
      'stopped',
    ]);
  });

  it('review can transition to done, in_progress, cancelled, archived, stopped', () => {
    expect(VALID_TASK_TRANSITIONS.review).toEqual([
      'done',
      'in_progress',
      'cancelled',
      'archived',
      'stopped',
    ]);
  });

  it('done can transition to in_progress and archived', () => {
    expect(VALID_TASK_TRANSITIONS.done).toEqual(['in_progress', 'archived']);
  });

  it('blocked can transition to open, in_progress, review, done, cancelled, archived, stopped', () => {
    expect(VALID_TASK_TRANSITIONS.blocked).toEqual([
      'open',
      'in_progress',
      'review',
      'done',
      'cancelled',
      'archived',
      'stopped',
    ]);
  });

  it('stopped can transition back to in_progress, cancelled, and archived', () => {
    expect(VALID_TASK_TRANSITIONS.stopped).toEqual(['in_progress', 'cancelled', 'archived']);
  });

  it('approved can transition to done, in_progress, archived, and cancelled', () => {
    expect(VALID_TASK_TRANSITIONS.approved).toEqual([
      'done',
      'in_progress',
      'archived',
      'cancelled',
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
      { target: 'archived', label: 'Archive' },
    ]);
  });

  it('returns correct actions for in_progress status', () => {
    const actions = getTransitionActions('in_progress');
    expect(actions).toEqual([
      { target: 'review', label: 'Submit for Review' },
      { target: 'done', label: 'Mark Done' },
      { target: 'blocked', label: 'Block' },
      { target: 'cancelled', label: 'Cancel' },
      { target: 'stopped', label: 'Stop' },
    ]);
  });

  it('returns Stop among the actions for review status', () => {
    const actions = getTransitionActions('review');
    expect(actions).toEqual([
      { target: 'done', label: 'Approve' },
      { target: 'in_progress', label: 'Reopen' },
      { target: 'cancelled', label: 'Cancel' },
      { target: 'archived', label: 'Archive' },
      { target: 'stopped', label: 'Stop' },
    ]);
  });

  it('returns Resume, Cancel, and Archive actions for stopped status', () => {
    const actions = getTransitionActions('stopped');
    expect(actions).toEqual([
      { target: 'in_progress', label: 'Resume' },
      { target: 'cancelled', label: 'Cancel' },
      { target: 'archived', label: 'Archive' },
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
      { target: 'done', label: 'Mark Done' },
      { target: 'cancelled', label: 'Cancel' },
      { target: 'archived', label: 'Archive' },
      { target: 'stopped', label: 'Stop' },
    ]);
  });

  it('offers Stop from in_progress, blocked, and review', () => {
    for (const status of ['in_progress', 'blocked', 'review'] as const) {
      expect(getTransitionActions(status).some((a) => a.target === 'stopped')).toBe(true);
    }
  });

  it('offers Resume from stopped', () => {
    expect(getTransitionActions('stopped').some((a) => a.label === 'Resume')).toBe(true);
  });

  it('no status offers a Pause action anymore', () => {
    for (const status of Object.keys(VALID_TASK_TRANSITIONS) as SpaceTaskStatus[]) {
      for (const action of getTransitionActions(status)) {
        expect(action.label).not.toBe('Pause');
      }
    }
    expect(VALID_TASK_TRANSITIONS.in_progress).not.toContain('open');
    expect(Object.keys(TRANSITION_LABELS)).not.toContain('in_progress->open');
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
    'stopped',
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

  it('calls onTransition with stopped when Stop clicked on in_progress', () => {
    const onTransition = vi.fn();
    const { getByTestId } = render(
      <TaskStatusActions status="in_progress" onTransition={onTransition} />
    );
    fireEvent.click(getByTestId('task-action-stopped'));
    expect(onTransition).toHaveBeenCalledWith('stopped');
  });

  it('renders Resume, Cancel, and Archive buttons for stopped status', () => {
    const onTransition = vi.fn();
    const { container, getByTestId } = render(
      <TaskStatusActions status="stopped" onTransition={onTransition} />
    );
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(3);
    expect(getByTestId('task-action-in_progress').textContent).toBe('Resume');
    expect(getByTestId('task-action-cancelled').textContent).toBe('Cancel');
    expect(getByTestId('task-action-archived').textContent).toBe('Archive');
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
      expect(queryByTestId('task-action-done')).toBeNull();
      expect(queryByTestId('task-action-cancelled')).toBeNull();
      expect(getByTestId('task-action-in_progress')).toBeTruthy();
      expect(getByTestId('task-action-archived')).toBeTruthy();
    });

    it('hides Approve / Cancel for any review task even when pendingCheckpointType is null', () => {
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
      expect(getByTestId('task-action-in_progress')).toBeTruthy();
      expect(getByTestId('task-action-archived')).toBeTruthy();
    });
  });
});
