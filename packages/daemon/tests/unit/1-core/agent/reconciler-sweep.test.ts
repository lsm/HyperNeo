import { describe, expect, it } from 'bun:test';
import {
  isStaleSubmittedDelivery,
  selectStaleSubmittedDeliveries,
} from '../../../../src/lib/agent/reconciler-sweep';

describe('selectStaleSubmittedDeliveries', () => {
  it('returns uuid-bearing submitted rows not in the active set', () => {
    const submitted = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }];
    const active = new Set(['b']);
    expect(selectStaleSubmittedDeliveries(submitted, active)).toEqual(['a', 'c']);
  });

  it('excludes missing or empty uuids', () => {
    const submitted: Array<{ uuid?: string }> = [{}, { uuid: '' }, { uuid: 'a' }];
    expect(selectStaleSubmittedDeliveries(submitted, new Set())).toEqual(['a']);
  });

  it('excludes uuids active in the job queue', () => {
    const submitted = [{ uuid: 'a' }, { uuid: 'b' }];
    const active = new Set(['a', 'b']);
    expect(selectStaleSubmittedDeliveries(submitted, active)).toEqual([]);
  });

  it('preserves order and keeps duplicates for independent settlement', () => {
    const submitted = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'a' }, { uuid: 'c' }];
    const active = new Set(['b']);
    expect(selectStaleSubmittedDeliveries(submitted, active)).toEqual(['a', 'a', 'c']);
  });

  it('returns an empty array for empty input', () => {
    expect(selectStaleSubmittedDeliveries([], new Set())).toEqual([]);
  });
});

describe('isStaleSubmittedDelivery', () => {
  it.each([
    ['a valid uuid outside the active set is stale', { uuid: 'a' }, new Set(['b']), true],
    ['a uuid active in the job queue is not stale', { uuid: 'a' }, new Set(['a']), false],
    ['an empty uuid is never stale', { uuid: '' }, new Set<string>(), false],
    ['a missing uuid is never stale', {}, new Set<string>(), false],
    ['an undefined uuid is never stale', { uuid: undefined }, new Set<string>(), false],
  ])('%s', (_label, row, active, expected) => {
    expect(isStaleSubmittedDelivery(row, active)).toBe(expected);
  });
});
