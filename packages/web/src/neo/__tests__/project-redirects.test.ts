import { describe, expect, it } from 'vitest';
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
