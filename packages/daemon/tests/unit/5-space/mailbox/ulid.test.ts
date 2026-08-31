import { describe, expect, test } from 'bun:test';
import { createUlid, isUlid } from '../../../../src/lib/space/mailbox/ulid';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function decodeBase32(value: string): bigint {
  let decoded = 0n;
  for (const char of value) {
    decoded = (decoded << 5n) | BigInt(CROCKFORD.indexOf(char));
  }
  return decoded;
}

describe('createUlid', () => {
  test('emits 26 chars from the Crockford alphabet', () => {
    for (let i = 0; i < 1000; i++) {
      const ulid = createUlid();
      expect(ulid).toHaveLength(26);
      for (const char of ulid) {
        expect(CROCKFORD).toContain(char);
      }
    }
  });

  test('embeds a deterministic time-ordered timestamp prefix', () => {
    const nowMs = 1_700_000_000_000;
    const prefix = createUlid(nowMs).slice(0, 10);
    expect(createUlid(nowMs).slice(0, 10)).toBe(prefix);
    expect(Number(decodeBase32(prefix))).toBe(nowMs);
  });

  test('is deterministic for a fixed injected clock', () => {
    for (const nowMs of [0, 1, 123_456_789, 1_700_000_000_000]) {
      const first = createUlid(nowMs).slice(0, 10);
      const second = createUlid(nowMs).slice(0, 10);
      expect(second).toBe(first);
      expect(Number(decodeBase32(second))).toBe(nowMs);
    }
  });

  test('orders across milliseconds by lexicographic string comparison', () => {
    const early = createUlid(1_700_000_000_000);
    const late = createUlid(1_700_000_000_001);
    expect(early < late).toBe(true);
    expect(early.slice(0, 10) < late.slice(0, 10)).toBe(true);
  });

  test('orders correctly when injected clocks arrive out of order', () => {
    const late = createUlid(1_700_000_000_001);
    const early = createUlid(1_700_000_000_000);
    expect(early < late).toBe(true);
  });

  test('increments strictly within the same millisecond', () => {
    const nowMs = 1_700_000_000_000;
    const seen = new Set<string>();
    let previous = createUlid(nowMs);
    seen.add(previous);
    for (let i = 0; i < 100; i++) {
      const next = createUlid(nowMs);
      expect(next > previous).toBe(true);
      expect(seen.has(next)).toBe(false);
      seen.add(next);
      previous = next;
    }
    expect(seen.size).toBe(101);
  });

  test('uses the current time when nowMs is omitted', () => {
    const before = Date.now();
    const ulid = createUlid();
    const after = Date.now();
    const embedded = Number(decodeBase32(ulid.slice(0, 10)));
    expect(embedded).toBeGreaterThanOrEqual(before);
    expect(embedded).toBeLessThanOrEqual(after);
  });
});

describe('isUlid', () => {
  test('accepts strings produced by createUlid', () => {
    expect(isUlid(createUlid(1_700_000_000_000))).toBe(true);
    for (let i = 0; i < 1000; i++) {
      expect(isUlid(createUlid())).toBe(true);
    }
  });

  test('rejects empty strings and wrong lengths', () => {
    const ulid = createUlid();
    expect(isUlid('')).toBe(false);
    expect(isUlid(ulid.slice(0, 25))).toBe(false);
    expect(isUlid(`${ulid}0`)).toBe(false);
    expect(isUlid('0123456789ABCDEFGHJKMNPQRSTVWXYZ')).toBe(false);
  });

  test('rejects lowercase letters', () => {
    const ulid = createUlid();
    expect(isUlid(ulid.toLowerCase())).toBe(false);
    expect(isUlid(ulid.slice(0, 10).toLowerCase() + ulid.slice(10))).toBe(false);
    expect(isUlid(ulid.slice(0, 16) + ulid.slice(16).toLowerCase())).toBe(false);
  });

  test('rejects characters outside the Crockford alphabet', () => {
    const ulid = createUlid();
    for (const forbidden of ['I', 'L', 'O', 'U', 'i', 'l', 'o', 'u', '-', '_', ' ', '.']) {
      const mutated = forbidden + ulid.slice(1);
      expect(isUlid(mutated)).toBe(false);
    }
  });

  test('rejects I/L/O/U at any position', () => {
    const ulid = createUlid();
    for (const forbidden of ['I', 'L', 'O', 'U']) {
      expect(isUlid(ulid.slice(0, 10) + forbidden + ulid.slice(11))).toBe(false);
      expect(isUlid(ulid.slice(0, 25) + forbidden)).toBe(false);
    }
  });

  test('returns false rather than throwing on any non-conforming input', () => {
    const inputs: unknown[] = [
      '',
      'x',
      'aaaa',
      '0123456789ABCDEFGHJKMNPQRSTVWXYZ',
      createUlid().slice(0, 10),
      null,
      undefined,
      12345,
      {},
      [],
    ];
    for (const input of inputs) {
      expect(() => isUlid(input as string)).not.toThrow();
      expect(isUlid(input as string)).toBe(false);
    }
  });
});
