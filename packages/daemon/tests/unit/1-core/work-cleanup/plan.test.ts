import { describe, expect, test } from 'bun:test';
import {
  planWorkRelease,
  type WorkFolderFacts,
} from '../../../../src/lib/work-cleanup/plan.ts';

const DAY = 24 * 60 * 60 * 1000;
const now = 100 * DAY;
const done = { kind: 'todo', state: 'done', boundToLiveTodo: false } as const;
const clean: WorkFolderFacts = { owner: done, inUse: false, unsaved: false };

describe('planWorkRelease', () => {
  test('a folder with no owner record is never removed, whatever else holds', () => {
    for (const evidence of [undefined, { since: 0, referenced: false as const }])
      expect(planWorkRelease({ ...clean, owner: null, evidence }, now)).toEqual({ keep: 'unknown' });
  });

  test('a live or unreadable owner keeps the folder', () => {
    for (const state of ['todo', 'doing', 'blocked', 'failed'] as const)
      expect(planWorkRelease({ ...clean, owner: { ...done, state } }, now)).toEqual({ keep: 'live' });
    expect(planWorkRelease({ ...clean, owner: { ...done, boundToLiveTodo: true } }, now)).toEqual({
      keep: 'live',
    });
    expect(
      planWorkRelease({ ...clean, owner: { kind: 'session', archived: false } }, now)
    ).toEqual({ keep: 'live' });
    expect(planWorkRelease({ ...clean, owner: 'unreadable' }, now)).toEqual({ keep: 'live' });
  });

  test('a running process inside, or a failed process check, keeps it', () => {
    expect(planWorkRelease({ ...clean, inUse: true }, now)).toEqual({ keep: 'in_use' });
    expect(planWorkRelease({ ...clean, inUse: 'unreadable' }, now)).toEqual({ keep: 'in_use' });
  });

  test('unsaved work, or Git status that cannot be read, keeps it', () => {
    expect(planWorkRelease({ ...clean, unsaved: true }, now)).toEqual({ keep: 'unsaved' });
    expect(planWorkRelease({ ...clean, unsaved: 'unreadable' }, now)).toEqual({ keep: 'unsaved' });
  });

  test('evidence goes 7 days after its todo finished unless something references it', () => {
    const evidence = (since: number | null, referenced: boolean | 'unreadable' = false) =>
      planWorkRelease({ ...clean, evidence: { since, referenced } }, now);
    expect(evidence(now - 7 * DAY)).toEqual({ remove: 'todo done' });
    expect(evidence(now - 7 * DAY + 1)).toEqual({ keep: 'evidence' });
    expect(evidence(now - 30 * DAY, true)).toEqual({ keep: 'evidence' });
    expect(evidence(now - 30 * DAY, 'unreadable')).toEqual({ keep: 'evidence' });
    expect(evidence(null)).toEqual({ keep: 'evidence' });
  });

  test('otherwise it is removed with the fact that allowed it', () => {
    expect(planWorkRelease(clean, now)).toEqual({ remove: 'todo done' });
    expect(planWorkRelease({ ...clean, owner: { ...done, state: 'removed' } }, now)).toEqual({
      remove: 'todo removed',
    });
    expect(
      planWorkRelease({ ...clean, owner: { kind: 'session', archived: true } }, now)
    ).toEqual({ remove: 'session archived' });
  });
});
