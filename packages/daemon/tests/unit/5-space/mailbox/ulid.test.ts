import { describe, expect, test } from 'bun:test';
import { createUlid, isUlid } from '../../../../src/lib/space/mailbox/ulid';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function charAt(value: string, index: number): string {
  return value[index];
}

describe('createUlid format', () => {
  test('emits exactly 26 characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(createUlid(1_700_000_000_000 + i)).toHaveLength(26);
    }
  });

  test('every character belongs to the Crockford alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const value = createUlid(1_700_000_000_000 + i);
      for (let j = 0; j < value.length; j++) {
        expect(ALPHABET.indexOf(charAt(value, j))).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('timestamp field is the leading 10 characters', () => {
    const value = createUlid(1_700_000_000_000);
    expect(value.slice(0, 10)).toHaveLength(10);
    expect(value.slice(10)).toHaveLength(16);
  });
});

describe('timestamp embedding', () => {
  test('a fixed clock produces a deterministic timestamp prefix', () => {
    expect(createUlid(1_700_000_000_000).slice(0, 10)).toBe(
      createUlid(1_700_000_000_000).slice(0, 10)
    );
  });

  test('the leading 10 chars encode the millisecond', () => {
    const value = createUlid(1_700_000_000_000);
    let decoded = 0n;
    for (let i = 0; i < 10; i++) {
      decoded = (decoded << 5n) | BigInt(ALPHABET.indexOf(value[i]));
    }
    expect(decoded).toBe(1_700_000_000_000n);
  });

  test('two different clocks give two different prefixes', () => {
    expect(createUlid(1_700_000_000_000).slice(0, 10)).not.toBe(
      createUlid(1_700_000_000_001).slice(0, 10)
    );
  });
});

describe('cross-millisecond ordering', () => {
  test('string compare equals chronological order', () => {
    const values: string[] = [];
    for (let i = 0; i < 200; i++) {
      values.push(createUlid(1_700_000_000_000 + i));
    }
    const sorted = [...values].sort();
    expect(values).toEqual(sorted);
  });

  test('ordering holds regardless of call order', () => {
    const earlier = createUlid(1_700_000_000_000);
    const later = createUlid(1_700_000_005_000);
    expect(earlier < later).toBe(true);
    expect(later > earlier).toBe(true);
  });
});

describe('same-millisecond monotonicity', () => {
  test('repeated calls at the same clock strictly increase', () => {
    let previous = createUlid(1_700_000_000_000);
    for (let i = 0; i < 100; i++) {
      const next = createUlid(1_700_000_000_000);
      expect(next > previous).toBe(true);
      previous = next;
    }
  });

  test('repeated calls never produce a duplicate', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(createUlid(1_700_000_000_000));
    }
    expect(seen.size).toBe(100);
  });

  test('a later clock beats an earlier run at the same millisecond', () => {
    for (let i = 0; i < 100; i++) {
      createUlid(1_700_000_000_000);
    }
    const next = createUlid(1_700_000_000_001);
    expect(next > createUlid(1_700_000_000_000)).toBe(true);
  });
});

describe('isUlid', () => {
  test('accepts strings produced by createUlid', () => {
    for (let i = 0; i < 20; i++) {
      expect(isUlid(createUlid(1_700_000_000_000 + i))).toBe(true);
    }
  });

  test('rejects the empty string', () => {
    expect(isUlid('')).toBe(false);
  });

  test('rejects wrong lengths', () => {
    expect(isUlid('short')).toBe(false);
    expect(isUlid(ALPHABET.repeat(3))).toBe(false);
    expect(isUlid('0'.repeat(25))).toBe(false);
    expect(isUlid('0'.repeat(27))).toBe(false);
  });

  test('rejects lowercase letters', () => {
    expect(isUlid(createUlid(1_700_000_000_000).toLowerCase())).toBe(false);
    expect(isUlid('0'.repeat(25) + 'a')).toBe(false);
  });

  test('rejects the excluded Crockford letters I, L, O, U', () => {
    for (const excluded of ['I', 'L', 'O', 'U']) {
      expect(isUlid('0'.repeat(25) + excluded)).toBe(false);
    }
  });

  test('rejects non-alphabetic characters', () => {
    expect(isUlid('0'.repeat(25) + '!')).toBe(false);
    expect(isUlid('0'.repeat(25) + ' ')).toBe(false);
  });

  test('returns false for non-string input without throwing', () => {
    expect(() => isUlid(undefined as unknown as string)).not.toThrow();
    expect(() => isUlid(null as unknown as string)).not.toThrow();
    expect(isUlid(undefined as unknown as string)).toBe(false);
    expect(isUlid(null as unknown as string)).toBe(false);
  });
});

describe('determinism under an injected clock', () => {
  test('the same nowMs always yields the same timestamp prefix', () => {
    expect(createUlid(1_700_000_000_123).slice(0, 10)).toBe(
      createUlid(1_700_000_000_123).slice(0, 10)
    );
  });

  test('the default clock still embeds a valid timestamp prefix', () => {
    const value = createUlid();
    let decoded = 0n;
    for (let i = 0; i < 10; i++) {
      decoded = (decoded << 5n) | BigInt(ALPHABET.indexOf(value[i]));
    }
    expect(decoded).toBeLessThanOrEqual(BigInt(Date.now()));
  });
});
