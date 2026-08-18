import { describe, test, expect } from 'bun:test';
import {
  appendDraftText,
  composeDraftWhole,
  generateUUID,
  matchesDraftOrComposition,
  parseJson,
  parseJsonOptional,
} from '../src/utils.ts';

describe('generateUUID', () => {
  test('generates valid UUID format', () => {
    const uuid = generateUUID();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test('generates unique UUIDs', () => {
    const uuid1 = generateUUID();
    const uuid2 = generateUUID();
    expect(uuid1).not.toBe(uuid2);
  });

  test('uses native crypto.randomUUID if available', () => {
    const uuid = generateUUID();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test('fallback works when crypto.randomUUID is not available', () => {
    const original = globalThis.crypto?.randomUUID;
    if (globalThis.crypto) {
      // @ts-expect-error - Intentionally setting to undefined for test
      globalThis.crypto.randomUUID = undefined;
    }

    const uuid = generateUUID();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    if (globalThis.crypto && original) {
      globalThis.crypto.randomUUID = original;
    }
  });

  test('fallback generates valid v4 UUID', () => {
    const original = globalThis.crypto?.randomUUID;
    if (globalThis.crypto) {
      // @ts-expect-error - Intentionally setting to undefined for test
      globalThis.crypto.randomUUID = undefined;
    }

    const uuid = generateUUID();

    expect(uuid[14]).toBe('4');

    expect(['8', '9', 'a', 'b']).toContain(uuid[19].toLowerCase());

    if (globalThis.crypto && original) {
      globalThis.crypto.randomUUID = original;
    }
  });

  test('generates multiple unique UUIDs in fallback mode', () => {
    const original = globalThis.crypto?.randomUUID;
    if (globalThis.crypto) {
      // @ts-expect-error - Intentionally setting to undefined for test
      globalThis.crypto.randomUUID = undefined;
    }

    const uuids = new Set();
    for (let i = 0; i < 100; i++) {
      uuids.add(generateUUID());
    }

    expect(uuids.size).toBe(100);

    if (globalThis.crypto && original) {
      globalThis.crypto.randomUUID = original;
    }
  });
});

describe('parseJson', () => {
  test('returns parsed value for valid JSON string', () => {
    const result1 = parseJson<Record<string, number>>('{"a":1}', {});
    expect(result1).toEqual({ a: 1 });

    const result2 = parseJson<number[]>('[1,2,3]', []);
    expect(result2).toEqual([1, 2, 3]);

    const result3 = parseJson<string>('"hello"', 'fallback');
    expect(result3).toBe('hello');

    const result4 = parseJson<number>('42', 0);
    expect(result4).toBe(42);

    const result5 = parseJson<boolean>('true', false);
    expect(result5).toBe(true);
  });

  test('returns fallback for null input', () => {
    const result1 = parseJson<string>(null, 'default');
    expect(result1).toBe('default');

    const result2 = parseJson<Record<string, number>>(null, { key: 1 });
    expect(result2).toEqual({ key: 1 });
  });

  test('returns fallback for undefined input', () => {
    const result1 = parseJson<string>(undefined, 'default');
    expect(result1).toBe('default');

    const result2 = parseJson<number[]>(undefined, [1, 2]);
    expect(result2).toEqual([1, 2]);
  });

  test('returns fallback for invalid JSON string', () => {
    const result1 = parseJson<string>('{not json}', 'fallback');
    expect(result1).toBe('fallback');

    const result2 = parseJson<Record<string, unknown>>('trailing comma,', {});
    expect(result2).toEqual({});

    const result3 = parseJson<Record<string, unknown>>('', {});
    expect(result3).toEqual({});
  });

  test('returns fallback for empty string', () => {
    const result1 = parseJson<string>('', 'default');
    expect(result1).toBe('default');

    const result2 = parseJson<number[]>('', []);
    expect(result2).toEqual([]);
  });
});

describe('parseJsonOptional', () => {
  test('returns parsed value for valid JSON string', () => {
    const result1 = parseJsonOptional<Record<string, number>>('{"a":1}');
    expect(result1).toEqual({ a: 1 });

    const result2 = parseJsonOptional<number[]>('[1,2,3]');
    expect(result2).toEqual([1, 2, 3]);

    const result3 = parseJsonOptional<string>('"hello"');
    expect(result3).toBe('hello');

    const result4 = parseJsonOptional<number>('42');
    expect(result4).toBe(42);

    const result5 = parseJsonOptional<boolean>('true');
    expect(result5).toBe(true);
  });

  test('returns undefined for null input', () => {
    expect(parseJsonOptional(null)).toBeUndefined();
  });

  test('returns undefined for undefined input', () => {
    expect(parseJsonOptional(undefined)).toBeUndefined();
  });

  test('returns undefined for invalid JSON string', () => {
    expect(parseJsonOptional('{not json}')).toBeUndefined();
    expect(parseJsonOptional('trailing comma,')).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(parseJsonOptional('')).toBeUndefined();
  });
});

describe('appendDraftText', () => {
  test('appends with a separating space between two latin words', () => {
    expect(appendDraftText('hello', 'world')).toBe('hello world');
  });

  test('does not prepend a space when existing is empty', () => {
    expect(appendDraftText('', 'hello')).toBe('hello');
  });

  test('does not insert a space across a CJK boundary (either side)', () => {
    expect(appendDraftText('你好', '世界')).toBe('你好世界');
    expect(appendDraftText('hello', '世界')).toBe('hello世界');
    expect(appendDraftText('你好', 'world')).toBe('你好world');
  });

  test('suppresses the space when existing already ends in whitespace', () => {
    expect(appendDraftText('hello ', 'world')).toBe('hello world');
    expect(appendDraftText('hello\n', 'world')).toBe('hello\nworld');
  });

  test('suppresses the space after an opening bracket or quote', () => {
    expect(appendDraftText('note (', 'detail')).toBe('note (detail');
    expect(appendDraftText('he said "', 'hi')).toBe('he said "hi');
  });

  test('keeps the space after sentence punctuation', () => {
    expect(appendDraftText('Hello.', 'World')).toBe('Hello. World');
    expect(appendDraftText('Stop!', 'go')).toBe('Stop! go');
  });

  test('caps the result at the draft character limit', () => {
    const big = 'a'.repeat(100_000);
    expect(appendDraftText(big, 'more').length).toBe(100_000);
    expect(appendDraftText('x', 'y'.repeat(200_000)).length).toBe(100_000);
  });
});

describe('composeDraftWhole', () => {
  test('returns the joined string when both parts fit whole (with separator)', () => {
    expect(composeDraftWhole('hello', 'world')).toBe('hello world');
  });

  test('returns the joined string with no separator across a CJK boundary', () => {
    expect(composeDraftWhole('你好', '世界')).toBe('你好世界');
  });

  test('returns the pending alone when the draft is empty', () => {
    expect(composeDraftWhole('', 'voice')).toBe('voice');
  });

  test('returns null when the join would be sliced at the character limit', () => {
    expect(composeDraftWhole('a'.repeat(100_000), 'more')).toBeNull();
  });

  test('accepts a composition of exactly the character limit', () => {
    const draft = 'x'.repeat(99_995);
    const composed = composeDraftWhole(draft, 'abcd');
    expect(composed).toBe(`${draft} abcd`);
    expect(composed?.length).toBe(100_000);
    expect(composeDraftWhole(`${draft}x`, 'abcd')).toBeNull();
  });
});

describe('matchesDraftOrComposition', () => {
  test("returns 'direct' when the stored draft equals the expected text", () => {
    expect(matchesDraftOrComposition('hello', 'voice', 'hello')).toBe('direct');
  });

  test("returns 'direct' with an empty stored draft and empty expected", () => {
    expect(matchesDraftOrComposition('', 'voice', '')).toBe('direct');
  });

  test("returns 'composition' when draft + pending compose the expected text", () => {
    expect(matchesDraftOrComposition('hello', 'voice', 'hello voice')).toBe('composition');
  });

  test("returns 'composition' for a voice-only composition (empty draft)", () => {
    expect(matchesDraftOrComposition('', 'voice', 'voice')).toBe('composition');
  });

  test('trims both sides before comparing', () => {
    expect(matchesDraftOrComposition('  hello  ', 'voice', ' hello ')).toBe('direct');
    expect(matchesDraftOrComposition('hello', 'voice', '  hello voice  ')).toBe('composition');
  });

  test('composes without a separator across a CJK boundary', () => {
    expect(matchesDraftOrComposition('你好', '世界', '你好世界')).toBe('composition');
  });

  test('returns null when neither the draft nor the composition matches', () => {
    expect(matchesDraftOrComposition('newer edits', 'voice', 'hello voice')).toBeNull();
    expect(matchesDraftOrComposition('hello', 'voice', 'unrelated')).toBeNull();
  });

  test('never reports a composition from an empty pending', () => {
    expect(matchesDraftOrComposition('hello', '', 'hello')).toBe('direct');
    expect(matchesDraftOrComposition('hello', '', 'hello there')).toBeNull();
  });
});
