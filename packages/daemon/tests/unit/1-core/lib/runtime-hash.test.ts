import { describe, expect, test } from 'bun:test';
import { hashString32, wyhash } from '../../../../src/lib/runtime-hash';

const MASK32 = 0xffffffffn;

const GOLDEN_FIXTURES: [string, string][] = [
  ['', 'e2bde459'],
  ['a', '09d28531'],
  ['hello', 'f93f532d'],
  ['ascii', 'b707bec7'],
  ['unicode: \u{1F600}', 'c0609998'],
  ['/Users/alice/code/my-project', '257c0b7b'],
  ['C:\\Users\\alice\\project', '5da3be24'],
  ['/very/long/path/' + 'a'.repeat(200), 'b36bb81a'],
  ['unicode-mix:\u{1F600}\u{1F680}\u{1F9D1}\u{200D}\u{1F33E}', '24aa0cb3'],
];

describe('runtime-hash', () => {
  for (const [value, expected] of GOLDEN_FIXTURES) {
    test(`wyhash produces the golden value for ${JSON.stringify(value)}`, () => {
      const got = Number(wyhash(value) & MASK32)
        .toString(16)
        .padStart(8, '0');
      expect(got).toBe(expected);
    });

    test(`hashString32 matches wyhash for ${JSON.stringify(value)}`, () => {
      expect(hashString32(value)).toBe(Number(wyhash(value) & MASK32));
    });
  }
});
