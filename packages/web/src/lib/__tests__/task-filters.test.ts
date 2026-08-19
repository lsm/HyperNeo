import type { SpaceTask, SpaceTaskStatus } from '@hyperneo/shared';
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
  'rate_limited',
  'usage_limited',
  'stopped',
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

  it('returns true for rate/usage-limited tasks (paused on a cap)', () => {
    expect(isActionRequired(makeTask('rate_limited'))).toBe(true);
    expect(isActionRequired(makeTask('usage_limited'))).toBe(true);
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

  it('only returns true for review, blocked, rate_limited, usage_limited across the full status set', () => {
    const matching = ALL_STATUSES.filter((s) => isActionRequired(makeTask(s)));
    expect(matching.sort()).toEqual(['blocked', 'rate_limited', 'review', 'usage_limited']);
  });

  it('returns false for stopped (dormant — own group lands with the stop switch-on)', () => {
    expect(isActionRequired(makeTask('stopped'))).toBe(false);
  });
});

describe('isActiveTask', () => {
  it.each([
    'open',
    'in_progress',
    'approved',
    'stopped',
  ] as const)('returns true for %s status', (status) => {
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
    expect(matching.sort()).toEqual(['approved', 'in_progress', 'open', 'stopped']);
  });

  it('returns true for stopped (dormant but resumable — surfaced in its own Active-tab group)', () => {
    expect(isActiveTask(makeTask('stopped'))).toBe(true);
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
    { id: 'stopped-1', status: 'stopped' },
  ];

  it('selects exactly the open / in_progress / approved / stopped rows', () => {
    const ids = fixture
      .filter((r) => isActiveTask({ status: r.status }))
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual(
      ['approved-1', 'approved-2', 'in_progress-1', 'open-1', 'open-2', 'stopped-1'].sort()
    );
  });

  it('every status is covered by exactly one of action / active / completed / archived (no orphan)', () => {
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
