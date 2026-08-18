import { describe, expect, it } from 'vitest';
import { getPriorityIndicatorTone } from './priority-tokens.js';

describe('priority-tokens', () => {
  it('maps high to warning', () => {
    expect(getPriorityIndicatorTone('high')).toBe('warning');
  });

  it('maps urgent to danger', () => {
    expect(getPriorityIndicatorTone('urgent')).toBe('danger');
  });

  it('maps low and normal to neutral', () => {
    expect(getPriorityIndicatorTone('low')).toBe('neutral');
    expect(getPriorityIndicatorTone('normal')).toBe('neutral');
  });
});
