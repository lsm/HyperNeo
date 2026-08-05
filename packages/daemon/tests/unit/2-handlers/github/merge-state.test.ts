import { describe, expect, it } from 'bun:test';
import {
  buildMergeStateQuery,
  classifyMergeStateStatus,
  parseMergeStateResponse,
} from '../../../../src/lib/external-events/github/merge-state';

describe('classifyMergeStateStatus', () => {
  it('classifies CLEAN and HAS_HOOKS as mergeable', () => {
    expect(classifyMergeStateStatus('CLEAN')).toBe('mergeable');
    expect(classifyMergeStateStatus('HAS_HOOKS')).toBe('mergeable');
  });

  it('classifies the four state-only blockers as merge_blocked', () => {
    expect(classifyMergeStateStatus('BEHIND')).toBe('merge_blocked');
    expect(classifyMergeStateStatus('BLOCKED')).toBe('merge_blocked');
    expect(classifyMergeStateStatus('UNSTABLE')).toBe('merge_blocked');
    expect(classifyMergeStateStatus('DRAFT')).toBe('merge_blocked');
  });

  it('classifies DIRTY (merge conflict) as a distinct merge_conflict bucket', () => {
    // Spec: DIRTY is excluded from the blocking set and recorded without emitting
    // a .merge_blocked topic. It gets its own bucket so transitions involving it
    // are tracked while its emission is suppressed by the poll loop.
    expect(classifyMergeStateStatus('DIRTY')).toBe('merge_conflict');
  });

  it('returns null for UNKNOWN so the caller skips instead of flipping', () => {
    expect(classifyMergeStateStatus('UNKNOWN')).toBeNull();
  });

  it('returns null for missing/empty status', () => {
    expect(classifyMergeStateStatus(undefined)).toBeNull();
    expect(classifyMergeStateStatus('')).toBeNull();
  });
});

describe('buildMergeStateQuery', () => {
  it('builds one batched query with an aliased pullRequest per PR number', () => {
    const { query, variables, aliasToNumber } = buildMergeStateQuery('acme', 'widgets', [7, 42]);
    expect(variables).toEqual({ owner: 'acme', name: 'widgets' });
    expect(aliasToNumber).toEqual({ pr_7: 7, pr_42: 42 });
    // Both PR numbers appear as aliased selections requesting mergeStateStatus.
    expect(query).toContain('pr_7: pullRequest(number: 7) { mergeStateStatus state number }');
    expect(query).toContain('pr_42: pullRequest(number: 42) { mergeStateStatus state number }');
    // Owner/name are parameterized, not interpolated, so they never break the query.
    expect(query).not.toContain('acme');
    expect(query).toContain('$owner: String!');
    expect(query).toContain('$name: String!');
  });

  it('produces an empty selection for no PR numbers (caller skips the request)', () => {
    const { query, aliasToNumber } = buildMergeStateQuery('acme', 'widgets', []);
    expect(aliasToNumber).toEqual({});
    expect(query).not.toContain('pullRequest(');
  });
});

describe('parseMergeStateResponse', () => {
  const aliasToNumber = { pr_7: 7, pr_42: 42 };

  it('decodes aliased PR nodes back to PR numbers with their status and state', () => {
    const body = {
      data: {
        repository: {
          pr_7: { mergeStateStatus: 'BLOCKED', state: 'OPEN', number: 7 },
          pr_42: { mergeStateStatus: 'CLEAN', state: 'OPEN', number: 42 },
        },
      },
    };
    expect(parseMergeStateResponse(body, aliasToNumber)).toEqual([
      { prNumber: 7, mergeStateStatus: 'BLOCKED', state: 'OPEN' },
      { prNumber: 42, mergeStateStatus: 'CLEAN', state: 'OPEN' },
    ]);
  });

  it('drops null PR values (deleted/inaccessible) without throwing', () => {
    const body = {
      data: { repository: { pr_7: null, pr_42: { mergeStateStatus: 'CLEAN', state: 'OPEN' } } },
    };
    expect(parseMergeStateResponse(body, aliasToNumber)).toEqual([
      { prNumber: 42, mergeStateStatus: 'CLEAN', state: 'OPEN' },
    ]);
  });

  it('returns an empty array when repository data is missing (access denied / errors payload)', () => {
    expect(parseMergeStateResponse({ data: { repository: null } }, aliasToNumber)).toEqual([]);
    expect(parseMergeStateResponse({ errors: [{ message: 'bad' }] }, aliasToNumber)).toEqual([]);
    expect(parseMergeStateResponse(null, aliasToNumber)).toEqual([]);
  });

  it('ignores response aliases not in the alias map', () => {
    const body = {
      data: {
        repository: {
          pr_7: { mergeStateStatus: 'CLEAN', state: 'OPEN' },
          someOtherAlias: { mergeStateStatus: 'CLEAN', state: 'OPEN' },
        },
      },
    };
    expect(parseMergeStateResponse(body, aliasToNumber)).toEqual([
      { prNumber: 7, mergeStateStatus: 'CLEAN', state: 'OPEN' },
    ]);
  });

  it('tolerates missing mergeStateStatus/state fields', () => {
    const body = { data: { repository: { pr_7: { state: 'OPEN' } } } };
    expect(parseMergeStateResponse(body, aliasToNumber)).toEqual([
      { prNumber: 7, mergeStateStatus: '', state: 'OPEN' },
    ]);
  });
});
