import { describe, test, expect } from 'bun:test';
import { formatShortId, parseShortId, isUUID } from '@hyperneo/shared';

describe('formatShortId', () => {
  test('formats prefix and counter', () => {
    expect(formatShortId('t', 42)).toBe('t-42');
  });

  test('formats goal prefix', () => {
    expect(formatShortId('g', 1)).toBe('g-1');
  });

  test('formats large counter', () => {
    expect(formatShortId('t', 9999)).toBe('t-9999');
  });
});

describe('parseShortId', () => {
  test('parses valid short ID', () => {
    expect(parseShortId('t-42')).toEqual({ prefix: 't', counter: 42 });
  });

  test('parses goal short ID', () => {
    expect(parseShortId('g-7')).toEqual({ prefix: 'g', counter: 7 });
  });

  test('returns null for non-numeric counter', () => {
    expect(parseShortId('t-abc')).toBeNull();
  });

  test('returns null for empty counter', () => {
    expect(parseShortId('t-')).toBeNull();
  });

  test('returns null for zero counter', () => {
    expect(parseShortId('t-0')).toBeNull();
  });

  test('returns null for uppercase prefix', () => {
    expect(parseShortId('T-42')).toBeNull();
  });

  test('returns null for multi-char prefix', () => {
    expect(parseShortId('ta-42')).toBeNull();
  });

  test('returns null for plain UUID', () => {
    expect(parseShortId('04062505-780f-4881-a3be-9cb9062790fb')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseShortId('')).toBeNull();
  });
});

describe('isUUID', () => {
  test('returns true for valid UUID v4', () => {
    expect(isUUID('04062505-780f-4881-a3be-9cb9062790fb')).toBe(true);
  });

  test('returns false for short ID', () => {
    expect(isUUID('t-42')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isUUID('')).toBe(false);
  });

  test('returns false for UUID v1 (version digit not 4)', () => {
    expect(isUUID('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
  });

  test('returns true for uppercase UUID', () => {
    expect(isUUID('04062505-780F-4881-A3BE-9CB9062790FB')).toBe(true);
  });

  test('returns false for malformed UUID', () => {
    expect(isUUID('04062505-780f-4881-a3be')).toBe(false);
  });
});
