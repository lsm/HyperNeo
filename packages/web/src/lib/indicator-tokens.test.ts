import { describe, expect, it } from 'vitest';
import {
  getToneClasses,
  INDICATOR_TONE_NAMES,
  INDICATOR_TONES,
  type IndicatorTone,
} from './indicator-tokens.js';

describe('indicator-tokens', () => {
  it('exports seven tones', () => {
    expect(INDICATOR_TONE_NAMES).toHaveLength(7);
    expect(new Set(INDICATOR_TONE_NAMES).size).toBe(7);
  });

  it.each(INDICATOR_TONE_NAMES)('tone %s has required class sets', (tone) => {
    const set = INDICATOR_TONES[tone as IndicatorTone];
    expect(set.bg).toMatch(/^bg-/);
    expect(set.text).toMatch(/^text-/);
    expect(set.border).toMatch(/^border-/);
    expect(set.soft).toContain(set.border);
    expect(set.soft).toContain(set.bg);
    expect(set.soft).toContain(set.text);
  });

  it.each(INDICATOR_TONE_NAMES)('tone %s exposes a literal solid spinner border class', (tone) => {
    const set = INDICATOR_TONES[tone as IndicatorTone];
    expect(set.spinner).toMatch(/^border-[a-z]+-500$/);
    expect(set.spinner).toBe(set.bg.replace('bg-', 'border-'));
  });

  it('maps neutral to gray family', () => {
    expect(INDICATOR_TONES.neutral.bg).toBe('bg-gray-500');
    expect(INDICATOR_TONES.neutral.text).toContain('text-gray-');
  });

  it('maps info to blue family', () => {
    expect(INDICATOR_TONES.info.bg).toBe('bg-blue-500');
    expect(INDICATOR_TONES.info.text).toBe('text-blue-400');
  });

  it('maps progress to yellow family', () => {
    expect(INDICATOR_TONES.progress.bg).toBe('bg-yellow-500');
    expect(INDICATOR_TONES.progress.text).toBe('text-yellow-400');
  });

  it('maps success to green family', () => {
    expect(INDICATOR_TONES.success.bg).toBe('bg-green-500');
    expect(INDICATOR_TONES.success.text).toBe('text-green-400');
  });

  it('maps warning to amber family', () => {
    expect(INDICATOR_TONES.warning.bg).toBe('bg-amber-500');
    expect(INDICATOR_TONES.warning.text).toBe('text-amber-400');
  });

  it('maps danger to red family', () => {
    expect(INDICATOR_TONES.danger.bg).toBe('bg-red-500');
    expect(INDICATOR_TONES.danger.text).toBe('text-red-400');
  });

  it('maps special to purple family', () => {
    expect(INDICATOR_TONES.special.bg).toBe('bg-purple-500');
    expect(INDICATOR_TONES.special.text).toBe('text-purple-400');
  });

  it('getToneClasses returns the matching set', () => {
    expect(getToneClasses('success').bg).toBe('bg-green-500');
  });

  it('exposes a literal spinner border for the progress and special tones', () => {
    expect(INDICATOR_TONES.progress.spinner).toBe('border-yellow-500');
    expect(INDICATOR_TONES.special.spinner).toBe('border-purple-500');
  });
});
