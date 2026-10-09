import type { SpaceTaskStatus } from '@hyperneo/shared';
import { VALID_TASK_TRANSITIONS } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import {
  canRunAgain,
  dropStatusOnlyStarts,
  filterDirectAttemptTargets,
  getTransitionActions,
} from '../task-actions';

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
      'Reopen',
      'Resume',
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

describe('menu moves to in progress', () => {
  const targets = (status: SpaceTaskStatus, workflowRunId?: string) =>
    dropStatusOnlyStarts(getTransitionActions(status), { status, workflowRunId }).map(
      ({ target }) => target
    );

  it('drops moves to in progress that would only write the status', () => {
    expect(targets('open')).not.toContain('in_progress');
    expect(targets('review')).not.toContain('in_progress');
    expect(targets('approved')).not.toContain('in_progress');
    expect(targets('stopped')).not.toContain('in_progress');
  });

  it('keeps workflow recovery, which restarts the run', () => {
    expect(targets('blocked', 'run-1')).toContain('in_progress');
    expect(targets('done', 'run-1')).toContain('in_progress');
    expect(targets('review', 'run-1')).not.toContain('in_progress');
  });
});

describe('canRunAgain', () => {
  const task = {
    workflowRunId: null,
    taskAgentSessionId: 's1',
    hasActiveDirectAttempt: false,
    archivedAt: null,
  };
  it('offers Run again for a stopped, cancelled or blocked task run without a workflow', () => {
    for (const status of ['stopped', 'cancelled', 'blocked'] as const)
      expect(canRunAgain({ ...task, status })).toBe(true);
  });
  it('does not offer it for workflow tasks, live attempts, open tasks or tasks never run', () => {
    expect(canRunAgain({ ...task, status: 'stopped', workflowRunId: 'run-1' })).toBe(false);
    expect(canRunAgain({ ...task, status: 'stopped', hasActiveDirectAttempt: true })).toBe(false);
    expect(canRunAgain({ ...task, status: 'open' })).toBe(false);
    expect(canRunAgain({ ...task, status: 'stopped', taskAgentSessionId: null })).toBe(false);
  });
});
