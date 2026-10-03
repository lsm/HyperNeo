import { describe, expect, it } from 'vitest';
import { LruCache } from '../lru-cache.ts';

describe('LruCache', () => {
  it('never holds more entries than its limit', () => {
    const cache = new LruCache<string, number>(3);
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, i);

    expect(cache.size).toBe(3);
    expect(cache.get('k6')).toBeUndefined();
    expect(cache.get('k9')).toBe(9);
  });

  it('evicts the least recently used entry', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);

    cache.set('c', 3);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });
});
