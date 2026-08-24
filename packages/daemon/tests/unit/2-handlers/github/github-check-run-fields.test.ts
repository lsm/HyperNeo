import { describe, expect, it } from 'bun:test';
import {
  checkRunAppKeyFrom,
  checkRunConclusionFrom,
  checkRunIdFrom,
  checkRunNameFrom,
  checkRunOccurredAt,
  checkRunTopicAction,
} from '../../../../src/lib/external-events/github/github-check-run-fields';

describe('checkRunIdFrom', () => {
  it('returns "unknown" for non-object rows', () => {
    expect(checkRunIdFrom(null)).toBe('unknown');
    expect(checkRunIdFrom(undefined)).toBe('unknown');
    expect(checkRunIdFrom('not-an-object')).toBe('unknown');
    expect(checkRunIdFrom(42)).toBe('unknown');
  });

  it('returns "unknown" when the row has no numeric/string id', () => {
    expect(checkRunIdFrom({})).toBe('unknown');
    expect(checkRunIdFrom({ id: null })).toBe('unknown');
    expect(checkRunIdFrom({ id: true })).toBe('unknown');
    expect(checkRunIdFrom({ id: { nested: 1 } })).toBe('unknown');
  });

  it('returns the numeric id verbatim', () => {
    expect(checkRunIdFrom({ id: 123456789 })).toBe(123456789);
  });

  it('returns the string id verbatim', () => {
    expect(checkRunIdFrom({ id: 'abc-123' })).toBe('abc-123');
  });
});

describe('checkRunConclusionFrom', () => {
  it('returns "" for non-object rows', () => {
    expect(checkRunConclusionFrom(null)).toBe('');
    expect(checkRunConclusionFrom(undefined)).toBe('');
    expect(checkRunConclusionFrom('x')).toBe('');
  });

  it('returns "" when the row has no string conclusion', () => {
    expect(checkRunConclusionFrom({})).toBe('');
    expect(checkRunConclusionFrom({ conclusion: null })).toBe('');
    expect(checkRunConclusionFrom({ conclusion: 5 })).toBe('');
  });

  it('returns the string conclusion verbatim', () => {
    expect(checkRunConclusionFrom({ conclusion: 'success' })).toBe('success');
    expect(checkRunConclusionFrom({ conclusion: 'failure' })).toBe('failure');
    expect(checkRunConclusionFrom({ conclusion: '' })).toBe('');
  });
});

describe('checkRunAppKeyFrom', () => {
  it('returns "" for non-object rows', () => {
    expect(checkRunAppKeyFrom(null)).toBe('');
    expect(checkRunAppKeyFrom(undefined)).toBe('');
    expect(checkRunAppKeyFrom('x')).toBe('');
  });

  it('returns "" when the row has no app object', () => {
    expect(checkRunAppKeyFrom({})).toBe('');
    expect(checkRunAppKeyFrom({ app: null })).toBe('');
    expect(checkRunAppKeyFrom({ app: 'github-actions' })).toBe('');
  });

  it('prefers a non-empty app.slug', () => {
    expect(checkRunAppKeyFrom({ app: { slug: 'github-actions', id: 123 } })).toBe('github-actions');
  });

  it('falls through app.id when slug is missing or empty', () => {
    expect(checkRunAppKeyFrom({ app: { id: 15368 } })).toBe('15368');
    expect(checkRunAppKeyFrom({ app: { slug: '', id: 15368 } })).toBe('15368');
    expect(checkRunAppKeyFrom({ app: { slug: null, id: 15368 } })).toBe('15368');
  });

  it('returns "" when neither slug nor a numeric id is present', () => {
    expect(checkRunAppKeyFrom({ app: {} })).toBe('');
    expect(checkRunAppKeyFrom({ app: { slug: '', id: 'not-a-number' } })).toBe('');
    expect(checkRunAppKeyFrom({ app: { id: '123' } })).toBe('');
  });
});

describe('checkRunNameFrom', () => {
  it('returns "" for non-object rows', () => {
    expect(checkRunNameFrom(null)).toBe('');
    expect(checkRunNameFrom(undefined)).toBe('');
    expect(checkRunNameFrom('x')).toBe('');
  });

  it('returns "" when the row has no string name', () => {
    expect(checkRunNameFrom({})).toBe('');
    expect(checkRunNameFrom({ name: null })).toBe('');
    expect(checkRunNameFrom({ name: 7 })).toBe('');
  });

  it('returns the string name verbatim', () => {
    expect(checkRunNameFrom({ name: 'CI / build' })).toBe('CI / build');
    expect(checkRunNameFrom({ name: '' })).toBe('');
  });
});

describe('checkRunTopicAction', () => {
  it('treats success, neutral, and empty conclusions as non-events', () => {
    expect(checkRunTopicAction('success')).toBeNull();
    expect(checkRunTopicAction('neutral')).toBeNull();
    expect(checkRunTopicAction('')).toBeNull();
  });

  it('maps cancelled and skipped conclusions onto their own topic actions', () => {
    expect(checkRunTopicAction('cancelled')).toBe('cancelled');
    expect(checkRunTopicAction('skipped')).toBe('skipped');
  });

  it('treats failure conclusions as failures', () => {
    expect(checkRunTopicAction('failure')).toBe('failed');
    expect(checkRunTopicAction('timed_out')).toBe('failed');
    expect(checkRunTopicAction('action_required')).toBe('failed');
    expect(checkRunTopicAction('startup_failure')).toBe('failed');
    expect(checkRunTopicAction('stale')).toBe('failed');
  });
});

describe('checkRunOccurredAt', () => {
  const completedAt = '2024-05-01T12:00:00Z';
  const updatedAt = '2024-05-01T11:00:00Z';
  const startedAt = '2024-05-01T10:00:00Z';

  it('returns the current time for a non-object row (Date.now fallback)', () => {
    const before = Date.now();
    const result = checkRunOccurredAt(null);
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it('prefers completed_at when present', () => {
    expect(
      checkRunOccurredAt({
        completed_at: completedAt,
        updated_at: updatedAt,
        started_at: startedAt,
      })
    ).toBe(Date.parse(completedAt));
  });

  it('falls back to updated_at when completed_at is absent', () => {
    expect(checkRunOccurredAt({ updated_at: updatedAt, started_at: startedAt })).toBe(
      Date.parse(updatedAt)
    );
    expect(
      checkRunOccurredAt({ completed_at: null, updated_at: updatedAt, started_at: startedAt })
    ).toBe(Date.parse(updatedAt));
  });

  it('falls back to started_at when completed_at and updated_at are absent', () => {
    expect(checkRunOccurredAt({ started_at: startedAt })).toBe(Date.parse(startedAt));
  });

  it('returns the current time when no timestamp field parses', () => {
    const before = Date.now();
    const result = checkRunOccurredAt({ completed_at: 'not-a-date' });
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});
