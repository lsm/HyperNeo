import { describe, expect, test } from 'bun:test';
import {
  ACTION_SAFETY_CLASSES,
  isActionSafetyClass,
  isMutatingSafetyClass,
} from '../../../../src/lib/space/actions/safety.ts';

describe('ACTION_SAFETY_CLASSES', () => {
  test('defines exactly the four safety classes', () => {
    expect([...ACTION_SAFETY_CLASSES]).toEqual(['read', 'mutate', 'destructive', 'human_only']);
  });
});

describe('isActionSafetyClass', () => {
  test('accepts every classified value', () => {
    for (const safetyClass of ACTION_SAFETY_CLASSES) {
      expect(isActionSafetyClass(safetyClass)).toBe(true);
    }
  });

  test('rejects unclassified values', () => {
    for (const value of [undefined, null, '', 'write', 'READ', 'mutating', 3, {}, ['read']]) {
      expect(isActionSafetyClass(value)).toBe(false);
    }
  });
});

describe('isMutatingSafetyClass', () => {
  test('read is the only non-mutating class', () => {
    expect(isMutatingSafetyClass('read')).toBe(false);
  });

  test('every non-read class counts as mutating', () => {
    for (const safetyClass of ['mutate', 'destructive', 'human_only'] as const) {
      expect(isMutatingSafetyClass(safetyClass)).toBe(true);
    }
  });
});
