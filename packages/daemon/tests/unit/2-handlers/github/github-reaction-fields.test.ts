import { describe, expect, it } from 'bun:test';
import {
  isPositiveReaction,
  reactionIdFrom,
} from '../../../../src/lib/external-events/github/github-reaction-fields';

describe('isPositiveReaction', () => {
  it('returns false for non-object rows', () => {
    expect(isPositiveReaction(null)).toBe(false);
    expect(isPositiveReaction(undefined)).toBe(false);
    expect(isPositiveReaction('+1')).toBe(false);
    expect(isPositiveReaction(42)).toBe(false);
  });

  it('returns false when the row has no content', () => {
    expect(isPositiveReaction({})).toBe(false);
    expect(isPositiveReaction({ content: null })).toBe(false);
    expect(isPositiveReaction({ content: undefined })).toBe(false);
  });

  it('returns true for the two positive-reaction content values', () => {
    expect(isPositiveReaction({ content: '+1' })).toBe(true);
    expect(isPositiveReaction({ content: 'thumbs_up' })).toBe(true);
  });

  it('returns false for the other GitHub reaction content values', () => {
    expect(isPositiveReaction({ content: '-1' })).toBe(false);
    expect(isPositiveReaction({ content: 'laugh' })).toBe(false);
    expect(isPositiveReaction({ content: 'confused' })).toBe(false);
    expect(isPositiveReaction({ content: 'heart' })).toBe(false);
    expect(isPositiveReaction({ content: 'hooray' })).toBe(false);
    expect(isPositiveReaction({ content: 'rocket' })).toBe(false);
    expect(isPositiveReaction({ content: 'eyes' })).toBe(false);
  });

  it('returns false for any other content string', () => {
    expect(isPositiveReaction({ content: 'anything-else' })).toBe(false);
    expect(isPositiveReaction({ content: '' })).toBe(false);
  });

  it('is an exact, case-sensitive match (whitespace/case variants are not positive)', () => {
    expect(isPositiveReaction({ content: '+1 ' })).toBe(false);
    expect(isPositiveReaction({ content: ' +1' })).toBe(false);
    expect(isPositiveReaction({ content: 'THUMBS_UP' })).toBe(false);
    expect(isPositiveReaction({ content: 'Thumbs_Up' })).toBe(false);
  });

  it('returns false when content is a non-string type', () => {
    expect(isPositiveReaction({ content: 1 })).toBe(false);
    expect(isPositiveReaction({ content: true })).toBe(false);
    expect(isPositiveReaction({ content: { value: '+1' } })).toBe(false);
  });
});

describe('reactionIdFrom', () => {
  it('returns empty string for non-object rows', () => {
    expect(reactionIdFrom(null)).toBe('');
    expect(reactionIdFrom(undefined)).toBe('');
    expect(reactionIdFrom('not-an-object')).toBe('');
    expect(reactionIdFrom(42)).toBe('');
  });

  it('returns empty string when the row has no numeric id', () => {
    expect(reactionIdFrom({})).toBe('');
    expect(reactionIdFrom({ id: null })).toBe('');
    expect(reactionIdFrom({ id: undefined })).toBe('');
  });

  it('returns the numeric id as a string', () => {
    expect(reactionIdFrom({ id: 12345 })).toBe('12345');
    expect(reactionIdFrom({ id: 0 })).toBe('0');
  });

  it('returns empty string for a non-numeric id', () => {
    expect(reactionIdFrom({ id: '12345' })).toBe('');
    expect(reactionIdFrom({ id: true })).toBe('');
    expect(reactionIdFrom({ id: { value: 1 } })).toBe('');
  });

  it('coerces any typeof-number id via String() (including edge cases)', () => {
    expect(reactionIdFrom({ id: 12.5 })).toBe('12.5');
    expect(reactionIdFrom({ id: Number.NaN })).toBe('NaN');
  });
});
