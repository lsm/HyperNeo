import type { SpaceTaskStatus } from '@hyperneo/shared';
import { VALID_TASK_TRANSITIONS } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import { filterDirectAttemptTargets, getTransitionActions } from '../task-actions';

const statuses = Object.keys(VALID_TASK_TRANSITIONS) as SpaceTaskStatus[];

describe('getTransitionActions', () => {
  it('offers Mark done, Cancel and Archive from every status except archived', () => {
    for (const status of statuses.filter((item) => item !== 'archived')) {
      const targets = getTransitionActions(status).map(({ target }) => target);
      for (const terminal of ['done', 'cancelled', 'archived'] as const) {
        if (terminal !== status)
          expect([status, targets.includes(terminal)]).toEqual([status, true]);
      }
    }
    expect(getTransitionActions('archived')).toEqual([]);
  });

  it('labels every action it offers and never offers runtime-owned statuses', () => {
    for (const status of statuses) {
      for (const { target, label } of getTransitionActions(status)) {
        expect([status, target, label === target]).toEqual([status, target, false]);
        expect(['approved', 'rate_limited', 'usage_limited']).not.toContain(target);
      }
    }
  });

  it('names the new terminal moves plainly', () => {
    expect(getTransitionActions('draft').map(({ label }) => label)).toEqual([
      'Publish',
      'Mark Done',
      'Cancel',
      'Archive',
    ]);
    expect(getTransitionActions('done').map(({ label }) => label)).toEqual([
      'Reopen as Open',
      'Reopen',
      'Cancel',
      'Archive',
    ]);
  });
});

describe('filterDirectAttemptTargets', () => {
  it('keeps the targets a running direct attempt can be shut down into, archive included', () => {
    const targets = filterDirectAttemptTargets(getTransitionActions('in_progress'), {
      hasActiveDirectAttempt: true,
      taskAgentSessionId: 'session-1',
    }).map(({ target }) => target);
    expect(targets).toEqual(['review', 'done', 'blocked', 'cancelled', 'stopped', 'archived']);
  });

  it('offers only Cancel while the attempt is reserved', () => {
    const targets = filterDirectAttemptTargets(getTransitionActions('in_progress'), {
      hasActiveDirectAttempt: true,
      taskAgentSessionId: null,
    }).map(({ target }) => target);
    expect(targets).toEqual(['cancelled']);
  });

  it('leaves the actions untouched when no attempt is live', () => {
    const actions = getTransitionActions('in_progress');
    expect(filterDirectAttemptTargets(actions, {})).toEqual(actions);
  });
});
