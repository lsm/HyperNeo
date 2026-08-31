import { describe, expect, test } from 'bun:test';
import { createUlid, isUlid } from '../../../../src/lib/space/mailbox/ulid';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_48_BIT = 281474976710655;

const TIMESTAMP_VECTORS: Array<[number, string]> = [
  [0, '0000000000'],
  [1, '0000000001'],
  [1000, '00000000Z8'],
  [1729000000000, '01JA86WGJG0'],
  [MAX_48_BIT, '7ZZZZZZZZZ'],
];

function decodeTimestamp(ulid: string): number {
  let value = 0;
  for (const char of ulid.slice(0, 10)) {
    value = value * 32 + CROCKFORD.indexOf(char);
  }
  return value;
}

function replaceAt(value: string, index: number, char: string): string {
  return value.slice(0, index) + char + value.slice(index + 1);
}

describe('createUlid', () => {
  test('emits 26 chars drawn from the Crockford alphabet', () => {
    for (let index = 0; index < 50; index += 1) {
      const ulid = createUlid();
      expect(ulid.length).toBe(26);
      for (const char of ulid) {
        expect(CROCKFORD.includes(char)).toBe(true);
      }
    }
  });

  test('embeds the injected clock as the first 10 chars', () => {
    for (const [timeMs, prefix] of TIMESTAMP_VECTORS) {
      expect(createUlid(timeMs).slice(0, 10)).toBe(prefix);
    }
  });

  test('timestamp prefix decodes back to the injected clock', () => {
    for (const [timeMs] of TIMESTAMP_VECTORS) {
      expect(decodeTimestamp(createUlid(timeMs))).toBe(timeMs);
    }
  });

  test('floors fractional injected clocks', () => {
    expect(createUlid(1000.9).slice(0, 10)).toBe('00000000Z8');
  });

  test('rejects timestamps outside the 48-bit range', () => {
    expect(() => createUlid(-1)).toThrow();
    expect(() => createUlid(MAX_48_BIT + 1)).toThrow();
  });

  test('uses the wall clock when nowMs is omitted', () => {
    const before = Date.now();
    const ulid = createUlid();
    const after = Date.now();
    expect(decodeTimestamp(ulid)).toBeGreaterThanOrEqual(before);
    expect(decodeTimestamp(ulid)).toBeLessThanOrEqual(after);
  });

  test('orders lexicographically across milliseconds regardless of call order', () => {
    const late = createUlid(2000);
    const early = createUlid(1000);
    const latest = createUlid(3000);
    expect(early < late).toBe(true);
    expect(late < latest).toBe(true);
    expect([latest, early, late].sort()).toEqual([early, late, latest]);
  });

  test('is strictly monotonic within the same millisecond', () => {
    const ids = Array.from({ length: 200 }, () => createUlid(50_000));
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index] > ids[index - 1]).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('keeps the timestamp prefix deterministic under an injected clock', () => {
    const first = createUlid(7000);
    createUlid(9000);
    const second = createUlid(7000);
    expect(second.slice(0, 10)).toBe(first.slice(0, 10));
    expect(second).not.toBe(first);
  });
});

describe('isUlid', () => {
  test('accepts generated ulids', () => {
    expect(isUlid(createUlid())).toBe(true);
    expect(isUlid(createUlid(0))).toBe(true);
    expect(isUlid(createUlid(MAX_48_BIT))).toBe(true);
  });

  test('rejects the empty string', () => {
    expect(isUlid('')).toBe(false);
  });

  test('rejects wrong lengths', () => {
    const base = createUlid(1729000000000);
    expect(isUlid(base.slice(1))).toBe(false);
    expect(isUlid(`${base}0`)).toBe(false);
  });

  test('rejects lowercase letters', () => {
    const base = createUlid(1729000000000);
    expect(isUlid(base.toLowerCase())).toBe(false);
    expect(isUlid(replaceAt(base, 15, 'a'))).toBe(false);
  });

  test('rejects characters outside the Crockford alphabet', () => {
    const base = createUlid(1729000000000);
    for (const char of ['I', 'L', 'O', 'U', ' ', '-', '#', '!', 'é']) {
      expect(isUlid(replaceAt(base, 20, char))).toBe(false);
    }
  });
});
