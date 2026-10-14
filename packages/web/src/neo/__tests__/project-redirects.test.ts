import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { describe, expect, it } from 'vitest';
import { neoActivityItems } from '../NeoActivity.tsx';
import { selectNeoProjectBoard } from '../neo-project-board.ts';
import { findNeoProject, resolveNeoProjectId } from '../project-redirects.ts';

const redirects = [
  { sourceId: 'a', targetId: 'b' },
  { sourceId: 'b', targetId: 'c' },
  { sourceId: 'x', targetId: 'y' },
  { sourceId: 'y', targetId: 'x' },
];
const kept = { id: 'c', title: 'Kept' };

describe('resolveNeoProjectId', () => {
  it('follows a merge chain to the kept project and stops on a loop', () => {
    expect(resolveNeoProjectId(redirects, 'a')).toBe('c');
    expect(resolveNeoProjectId(redirects, 'c')).toBe('c');
    expect(resolveNeoProjectId(redirects, null)).toBeNull();
    expect(resolveNeoProjectId(undefined, 'a')).toBe('a');
    expect(['x', 'y']).toContain(resolveNeoProjectId(redirects, 'x'));
  });
});

describe('findNeoProject', () => {
  it('finds the kept project from a merged-away id', () => {
    expect(findNeoProject([kept], redirects, 'a')).toBe(kept);
    expect(findNeoProject([kept], undefined, 'a')).toBeUndefined();
  });
});

describe('selectNeoProjectBoard', () => {
  it('opens the kept project for an old id and keeps work still filed under the old id', () => {
    const snapshot = {
      ok: true,
      sessionId: null,
      projects: [kept],
      projectRedirects: redirects,
      work: [
        { id: 'w-old', projectId: 'a' },
        { id: 'w-new', projectId: 'c' },
        { id: 'w-other', projectId: 'z' },
      ],
      consultations: [],
      cards: [],
      askViews: [],
    } as unknown as NeoSnapshot;
    const selected = selectNeoProjectBoard(snapshot, 'a');
    if (!('value' in selected)) throw new Error('expected a board');
    expect(selected.value.project).toBe(kept);
    expect(selected.value.work.map((item) => item.id)).toEqual(['w-old', 'w-new']);
  });
});

describe('neoActivityItems', () => {
  it('names a context holder by its kept project', () => {
    const scene = {
      group: 'running',
      label: 'Checking context',
      ref: { kind: 'consultation', id: 'c1' },
      receipt: { kind: 'consultation', projectId: 'a' },
    } as never;
    expect(neoActivityItems([scene], [kept], redirects)[0]?.text).toBe('Checking context · Kept');
  });
});
