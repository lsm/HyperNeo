import { describe, expect, it } from 'vitest';
import type { WorkspaceHistoryEntry } from '@hyperneo/shared';
import { judgeFolderTarget } from '../projects';

const project = { id: 'p1', name: 'Alpha', folders: ['/alpha'] };
const withTarget: WorkspaceHistoryEntry[] = [
  { path: '/alpha', lastUsedAt: 1, useCount: 1, project },
];
const without: WorkspaceHistoryEntry[] = [
  {
    path: '/other',
    lastUsedAt: 1,
    useCount: 1,
    project: { id: 'p2', name: 'Other', folders: ['/other'] },
  },
];
const empty: WorkspaceHistoryEntry[] = [];

describe('judgeFolderTarget', () => {
  it.each([
    ['fresh ok, project present, loaded', withTarget, withTarget, true, 'add'],
    ['fresh ok, project present, never loaded', withTarget, empty, false, 'add'],
    ['fresh ok, project absent, loaded', without, withTarget, true, 'refuse'],
    ['fresh ok, project absent, never loaded', without, empty, false, 'refuse'],
    ['fresh ok, empty, loaded', empty, withTarget, true, 'refuse'],
    ['fresh ok, empty, never loaded', empty, empty, false, 'refuse'],
    ['fresh failed, cached present, loaded', null, withTarget, true, 'add'],
    ['fresh failed, cached present, never loaded', null, withTarget, false, 'add'],
    ['fresh failed, cached absent, loaded', null, without, true, 'refuse'],
    ['fresh failed, cached empty, loaded', null, empty, true, 'refuse'],
    ['fresh failed, cached absent, never loaded', null, without, false, 'add'],
    ['fresh failed, cached empty, never loaded', null, empty, false, 'add'],
  ] as const)('%s', (_name, fresh, cached, loaded, decision) => {
    expect(judgeFolderTarget('/alpha', fresh, cached, loaded).decision).toBe(decision);
  });

  it('names the owning project when the fresh read says the target is gone', () => {
    expect(judgeFolderTarget('/alpha', without, empty, false)).toEqual({
      decision: 'refuse',
      message: 'alpha is no longer a project. Add the folder as a project instead.',
    });
  });
});
