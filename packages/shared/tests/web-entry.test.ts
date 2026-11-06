import { describe, expect, test } from 'bun:test';
import { resolveNeoEntry } from '../src/web-entry.ts';

describe('resolveNeoEntry', () => {
  test.each(['/', '/?examples&x=a%20b#message', '/neo', '/neo?examples'])(
    'serves the Neo entry at %s without changing the URL',
    (path) => {
      const url = new URL(path, 'http://localhost');
      const original = url.href;
      expect(resolveNeoEntry(url)).toEqual({
        kind: 'entry',
        path: '/neo/index.html',
      });
      expect(url.href).toBe(original);
    }
  );

  test.each(['/neo/', '/neo/index.html'])(
    'canonicalizes %s without losing query parameters or fragment',
    (path) => {
      expect(
        resolveNeoEntry(new URL(`${path}?examples&x=a%20b#message`, 'http://localhost'))
      ).toEqual({ kind: 'redirect', location: '/neo?examples&x=a%20b#message' });
    }
  );

  test.each([
    '/sessions',
    '/sessions?filter=idle',
    '/settings?tab=devices',
    '/spaces',
    '/session/abc',
    '/neo/client.tsx',
    '/neon',
    '/neo/other',
  ])('leaves %s unchanged', (path) => {
    expect(resolveNeoEntry(new URL(path, 'http://localhost'))).toBeNull();
  });
});
