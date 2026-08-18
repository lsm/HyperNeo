import { describe, expect, it } from 'bun:test';
import {
  isPullRequestOpen,
  pullRequestUpdatedAt,
} from '../../../../src/lib/external-events/github/github-pr-row-state';

describe('pullRequestUpdatedAt', () => {
  const updatedAt = '2024-05-01T12:00:00Z';

  it('returns 0 for non-object rows', () => {
    expect(pullRequestUpdatedAt(null)).toBe(0);
    expect(pullRequestUpdatedAt(undefined)).toBe(0);
    expect(pullRequestUpdatedAt('not-an-object')).toBe(0);
    expect(pullRequestUpdatedAt(42)).toBe(0);
  });

  it('returns the parsed epoch-millis for a valid updated_at string', () => {
    expect(pullRequestUpdatedAt({ updated_at: updatedAt })).toBe(Date.parse(updatedAt));
  });

  it('returns the current time (Date.now fallback) when updated_at is absent', () => {
    const before = Date.now();
    const result = pullRequestUpdatedAt({});
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it('returns the current time when updated_at is null or a non-string type', () => {
    const before = Date.now();
    const a = pullRequestUpdatedAt({ updated_at: null });
    const b = pullRequestUpdatedAt({ updated_at: 1714564800000 });
    const c = pullRequestUpdatedAt({ updated_at: true });
    const after = Date.now();
    for (const result of [a, b, c]) {
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    }
  });

  it('returns the current time when updated_at is an unparseable string', () => {
    const before = Date.now();
    const result = pullRequestUpdatedAt({ updated_at: 'not-a-date' });
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it('treats an empty-string updated_at as absent (Date.now fallback)', () => {
    const before = Date.now();
    const result = pullRequestUpdatedAt({ updated_at: '' });
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});

describe('isPullRequestOpen', () => {
  it('returns false for non-object rows', () => {
    expect(isPullRequestOpen(null)).toBe(false);
    expect(isPullRequestOpen(undefined)).toBe(false);
    expect(isPullRequestOpen('open')).toBe(false);
    expect(isPullRequestOpen(42)).toBe(false);
  });

  it('returns false when the row has no state', () => {
    expect(isPullRequestOpen({})).toBe(false);
    expect(isPullRequestOpen({ state: null })).toBe(false);
    expect(isPullRequestOpen({ state: undefined })).toBe(false);
  });

  it('returns true only for the literal state "open"', () => {
    expect(isPullRequestOpen({ state: 'open' })).toBe(true);
  });

  it('returns false for closed/merged and any other state string', () => {
    expect(isPullRequestOpen({ state: 'closed' })).toBe(false);
    expect(isPullRequestOpen({ state: 'merged' })).toBe(false);
    expect(isPullRequestOpen({ state: '' })).toBe(false);
    expect(isPullRequestOpen({ state: 'anything-else' })).toBe(false);
  });

  it('is case-sensitive (uppercase "OPEN" is not open)', () => {
    expect(isPullRequestOpen({ state: 'OPEN' })).toBe(false);
    expect(isPullRequestOpen({ state: 'Open' })).toBe(false);
  });

  it('returns false when state is a non-string type', () => {
    expect(isPullRequestOpen({ state: 1 })).toBe(false);
    expect(isPullRequestOpen({ state: true })).toBe(false);
    expect(isPullRequestOpen({ state: { open: true } })).toBe(false);
  });
});
