import { describe, expect, test } from 'bun:test';
import { resolveNeoEntry } from '../src/web-entry.ts';

describe('resolveNeoEntry', () => {
  test.each(['/neo', '/neo?examples'])('serves the Neo entry at %s', (path) => {
    expect(resolveNeoEntry(new URL(path, 'http://localhost'))).toEqual({
      kind: 'entry',
      path: '/neo/index.html',
    });
  });

  test.each(['/neo/', '/neo/index.html'])(
    'canonicalizes %s without losing query parameters or fragment',
    (path) => {
      expect(
        resolveNeoEntry(new URL(`${path}?examples&x=a%20b#message`, 'http://localhost'))
      ).toEqual({ kind: 'redirect', location: '/neo?examples&x=a%20b#message' });
    }
  );

  test.each(['/', '/spaces', '/session/abc', '/neo/client.tsx', '/neon', '/neo/other'])(
    'leaves %s unchanged',
    (path) => {
      expect(resolveNeoEntry(new URL(path, 'http://localhost'))).toBeNull();
    }
  );
});
