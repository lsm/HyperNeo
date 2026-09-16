import { describe, expect, test } from 'bun:test';
import { OPERATION_NAME_FAMILIES, OPERATION_NAMES } from '@hyperneo/shared/types/operation-names';

describe('OPERATION_NAMES', () => {
  test('is the concatenation of the family arrays with no duplicates', () => {
    const fromFamilies = Object.values(OPERATION_NAME_FAMILIES).flatMap((names) => [...names]);
    expect([...OPERATION_NAMES]).toEqual(fromFamilies);
    expect(new Set(OPERATION_NAMES).size).toBe(OPERATION_NAMES.length);
  });

  test('keeps every family array sorted so additions never collide', () => {
    for (const [family, names] of Object.entries(OPERATION_NAME_FAMILIES)) {
      expect({ family, names: [...names] }).toEqual({ family, names: [...names].sort() });
    }
  });
});
