import { describe, expect, it } from 'vitest';
import { buildOverride, extractOverrideValue } from '../WorkflowNodeCard';
import type { WorkflowNodeAgentOverride } from '@hyperneo/shared';

describe('extractOverrideValue', () => {
  it('returns empty string for undefined', () => {
    expect(extractOverrideValue(undefined)).toBe('');
  });

  it('returns empty string for null', () => {
    expect(extractOverrideValue(null as unknown as WorkflowNodeAgentOverride)).toBe('');
  });

  it('returns the string value for plain string input', () => {
    expect(extractOverrideValue('hello world')).toBe('hello world');
  });

  it('returns the value property for override object', () => {
    expect(extractOverrideValue({ value: 'system prompt text' })).toBe('system prompt text');
  });

  it('returns the value property for another override object', () => {
    expect(extractOverrideValue({ value: 'extra context' })).toBe('extra context');
  });

  it('returns empty string when override value is empty', () => {
    expect(extractOverrideValue({ value: '' })).toBe('');
  });

  it('returns empty string when override value is undefined', () => {
    expect(extractOverrideValue({ value: undefined as unknown as string })).toBe('');
  });
});

describe('buildOverride', () => {
  it('returns override object for non-empty value', () => {
    const result = buildOverride('Custom prompt.');
    expect(result).toEqual({ value: 'Custom prompt.' });
  });

  it('returns override object for another non-empty value', () => {
    const result = buildOverride('Extra context.');
    expect(result).toEqual({ value: 'Extra context.' });
  });

  it('returns undefined for empty string', () => {
    expect(buildOverride('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(buildOverride('   ')).toBeUndefined();
  });

  it('preserves leading, trailing, and inner whitespace', () => {
    const result = buildOverride('  Custom prompt.\nSecond line ');
    expect(result).toEqual({ value: '  Custom prompt.\nSecond line ' });
  });
});
