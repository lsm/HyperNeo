import { describe, expect, it } from 'bun:test';
import {
  addPullRequestNumberByHeadRef,
  removePullRequestNumberByHeadRef,
} from '../../../../src/lib/external-events/github/github-pr-head-ref-index';

function snapshot(map: Map<string, number[]>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [key, numbers] of map) out[key] = [...numbers];
  return out;
}

describe('addPullRequestNumberByHeadRef', () => {
  it('creates a new single-element entry for a key not yet in the index', () => {
    const index = new Map<string, number[]>();
    addPullRequestNumberByHeadRef(index, 'owner/repo@abc', 42);
    expect(snapshot(index)).toEqual({ 'owner/repo@abc': [42] });
  });

  it('appends a new number to an existing key', () => {
    const index = new Map<string, number[]>([['owner/repo@abc', [42]]]);
    addPullRequestNumberByHeadRef(index, 'owner/repo@abc', 7);
    expect(snapshot(index)).toEqual({ 'owner/repo@abc': [42, 7] });
  });

  it('dedupes: adding a number already under the key is a no-op', () => {
    const index = new Map<string, number[]>([['owner/repo@abc', [42, 7]]]);
    addPullRequestNumberByHeadRef(index, 'owner/repo@abc', 42);
    expect(snapshot(index)).toEqual({ 'owner/repo@abc': [42, 7] });
  });

  it('seeds a brand-new key with a fresh array (keys are independent)', () => {
    const index = new Map<string, number[]>();
    addPullRequestNumberByHeadRef(index, 'a@1', 1);
    addPullRequestNumberByHeadRef(index, 'b@2', 2);
    expect(snapshot(index)).toEqual({ 'a@1': [1], 'b@2': [2] });
    index.get('a@1')?.push(99);
    expect(snapshot(index)).toEqual({ 'a@1': [1, 99], 'b@2': [2] });
  });

  it('treats the head-ref key as an opaque string (no SHA-specific parsing)', () => {
    const index = new Map<string, number[]>();
    addPullRequestNumberByHeadRef(index, 'not-a-sha', 5);
    expect(snapshot(index)).toEqual({ 'not-a-sha': [5] });
  });
});

describe('removePullRequestNumberByHeadRef', () => {
  it('is a no-op when the key is absent (index unchanged, no throw)', () => {
    const index = new Map<string, number[]>([['a@1', [1]]]);
    removePullRequestNumberByHeadRef(index, 'absent', 1);
    expect(snapshot(index)).toEqual({ 'a@1': [1] });
  });

  it('removes one number of several and keeps the key with the rest', () => {
    const index = new Map<string, number[]>([['a@1', [42, 7, 3]]]);
    removePullRequestNumberByHeadRef(index, 'a@1', 7);
    expect(snapshot(index)).toEqual({ 'a@1': [42, 3] });
  });

  it('deletes the key outright when its last number is removed (no empty lists)', () => {
    const index = new Map<string, number[]>([['a@1', [42]]]);
    removePullRequestNumberByHeadRef(index, 'a@1', 42);
    expect(snapshot(index)).toEqual({});
    expect(index.has('a@1')).toBe(false);
  });

  it('is a no-op when the number is not present under an existing key', () => {
    const index = new Map<string, number[]>([['a@1', [42, 7]]]);
    removePullRequestNumberByHeadRef(index, 'a@1', 999);
    expect(snapshot(index)).toEqual({ 'a@1': [42, 7] });
  });

  it('only removes the first matching value once even if duplicated', () => {
    const index = new Map<string, number[]>([['a@1', [42, 42, 7]]]);
    removePullRequestNumberByHeadRef(index, 'a@1', 42);
    expect(snapshot(index)).toEqual({ 'a@1': [7] });
  });
});

describe('head-ref index invariant across add + remove', () => {
  it('a key added then removed round-trips back to absent (not an empty list)', () => {
    const index = new Map<string, number[]>();
    addPullRequestNumberByHeadRef(index, 'a@1', 42);
    expect(snapshot(index)).toEqual({ 'a@1': [42] });
    removePullRequestNumberByHeadRef(index, 'a@1', 42);
    expect(snapshot(index)).toEqual({});
  });

  it('preserves remaining numbers and their order through a partial removal', () => {
    const index = new Map<string, number[]>();
    addPullRequestNumberByHeadRef(index, 'a@1', 3);
    addPullRequestNumberByHeadRef(index, 'a@1', 1);
    addPullRequestNumberByHeadRef(index, 'a@1', 2);
    removePullRequestNumberByHeadRef(index, 'a@1', 1);
    expect(snapshot(index)).toEqual({ 'a@1': [3, 2] });
  });

  it('keeps unrelated keys untouched when one key is removed down to empty', () => {
    const index = new Map<string, number[]>();
    addPullRequestNumberByHeadRef(index, 'a@1', 1);
    addPullRequestNumberByHeadRef(index, 'b@2', 2);
    addPullRequestNumberByHeadRef(index, 'b@2', 3);
    removePullRequestNumberByHeadRef(index, 'a@1', 1);
    expect(snapshot(index)).toEqual({ 'b@2': [2, 3] });
  });
});
