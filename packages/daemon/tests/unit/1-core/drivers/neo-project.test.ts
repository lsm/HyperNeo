import { describe, expect, test } from 'bun:test';
import { ensureNeoProject } from '../../../../src/lib/neo/folder';

describe('ensureNeoProject', () => {
  test('registers the Neo folder once, without bumping it on later starts', () => {
    const rows = new Map<string, number>();
    const history = {
      get: (path: string) => (rows.has(path) ? ({ path } as never) : null),
      upsert: (path: string) => {
        rows.set(path, (rows.get(path) ?? 0) + 1);
        return { path } as never;
      },
    };
    expect(ensureNeoProject(history, () => '/data/Neo')).toBe('/data/Neo');
    ensureNeoProject(history, () => '/data/Neo');
    expect([...rows]).toEqual([['/data/Neo', 1]]);
  });
});
