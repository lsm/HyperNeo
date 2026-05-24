/**
 * Tests for the shared task-filter predicates used by the Action tab and
 * the sidebar Tasks badge in `SpaceDetailPanel`.
 */

import type { SpaceTask, SpaceTaskStatus } from '@neokai/shared';
import { describe, expect, it } from 'vitest';
import { isActionRequired, isActiveTask } from '../task-filters';

const ALL_STATUSES: SpaceTaskStatus[] = [
  'open',
  'in_progress',
  'review',
  'approved',
  'done',
  'blocked',
  'cancelled',
  'archived',
];

function makeTask(status: SpaceTaskStatus): Pick<SpaceTask, 'status'> {
  return { status };
}

describe('isActionRequired', () => {
  it('returns true for blocked tasks regardless of block_reason', () => {
    expect(isActionRequired(makeTask('blocked'))).toBe(true);
  });

  it('returns true for review tasks (awaiting approval)', () => {
    expect(isActionRequired(makeTask('review'))).toBe(true);
  });

  it.each([
    'open',
    'in_progress',
    'approved',
    'done',
    'cancelled',
    'archived',
  ] as const)('returns false for %s status', (status) => {
    expect(isActionRequired(makeTask(status))).toBe(false);
  });

  it('only returns true for review and blocked across the full status set', () => {
    const matching = ALL_STATUSES.filter((s) => isActionRequired(makeTask(s)));
    expect(matching.sort()).toEqual(['blocked', 'review']);
  });
});

describe('isActiveTask', () => {
  it.each(['open', 'in_progress', 'approved'] as const)('returns true for %s status', (status) => {
    expect(isActiveTask(makeTask(status))).toBe(true);
  });

  it.each([
    'review',
    'blocked',
    'done',
    'cancelled',
    'archived',
  ] as const)('returns false for %s status', (status) => {
    expect(isActiveTask(makeTask(status))).toBe(false);
  });

  it('classifies the full status set deterministically', () => {
    const matching = ALL_STATUSES.filter((s) => isActiveTask(makeTask(s)));
    expect(matching.sort()).toEqual(['approved', 'in_progress', 'open']);
  });
});

describe('isActionRequired and isActiveTask are mutually exclusive', () => {
  it('no status satisfies both predicates simultaneously', () => {
    for (const status of ALL_STATUSES) {
      const task = makeTask(status);
      const both = isActionRequired(task) && isActiveTask(task);
      expect(both).toBe(false);
    }
  });
});

/**
 * Regression test for the bug where the sidebar "Active" tab and the
 * main-pane Tasks "Active" tab disagreed about whether `approved` tasks
 * belong in Active. The fixture covers every `SpaceTaskStatus` and asserts
 * the predicate's output over a heterogeneous list. The companion check
 * that the tasks-view's `TAB_PREDICATES.active` resolves to the same
 * function lives in `SpaceTasks.test.tsx` (where the necessary signal /
 * store mocks are already configured), keeping this file focused on the
 * pure-function predicate behaviour.
 */
describe('Active filter — fixture coverage', () => {
  type Row = { id: string; status: SpaceTaskStatus };

  const fixture: Row[] = [
    { id: 'open-1', status: 'open' },
    { id: 'open-2', status: 'open' },
    { id: 'in_progress-1', status: 'in_progress' },
    { id: 'review-1', status: 'review' },
    { id: 'approved-1', status: 'approved' },
    { id: 'approved-2', status: 'approved' },
    { id: 'done-1', status: 'done' },
    { id: 'blocked-1', status: 'blocked' },
    { id: 'cancelled-1', status: 'cancelled' },
    { id: 'archived-1', status: 'archived' },
  ];

  it('selects exactly the open / in_progress / approved rows', () => {
    const ids = fixture
      .filter((r) => isActiveTask({ status: r.status }))
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual(['approved-1', 'approved-2', 'in_progress-1', 'open-1', 'open-2'].sort());
  });

  it('every status is covered by exactly one of action / active / completed / archived (no orphan)', () => {
    // Mirrors the 4-tab partition in SpaceTasks. `review` and `blocked`
    // land in action; `open`/`in_progress`/`approved` land in active;
    // `done`/`cancelled` land in completed; `archived` lands in archived.
    const completedStatuses: SpaceTaskStatus[] = ['done', 'cancelled'];
    const archivedStatuses: SpaceTaskStatus[] = ['archived'];

    for (const status of ALL_STATUSES) {
      const task = makeTask(status);
      const inAction = isActionRequired(task);
      const inActive = isActiveTask(task);
      const inCompleted = completedStatuses.includes(status);
      const inArchived = archivedStatuses.includes(status);
      const memberships = [inAction, inActive, inCompleted, inArchived].filter(Boolean).length;
      expect({ status, memberships }).toEqual({ status, memberships: 1 });
    }
  });
});
