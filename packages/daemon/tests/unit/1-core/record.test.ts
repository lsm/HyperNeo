import { describe, expect, test } from 'bun:test';
import { asRecord, isRecord } from '../../../src/lib/record.ts';

describe('record guards', () => {
  test.each([
    null,
    undefined,
    false,
    true,
    0,
    1,
    '',
    'object',
    Symbol('object'),
    [],
    [1],
    () => ({}),
  ])('rejects non-record value %s', (value) => {
    expect(isRecord(value)).toBe(false);
    expect(asRecord(value)).toBeNull();
  });

  test.each([{}, { value: 1 }, Object.create(null), new Date(0), /record/])(
    'preserves the identity of non-array objects',
    (value) => {
      expect(isRecord(value)).toBe(true);
      expect(asRecord(value)).toBe(value);
    }
  );
});
