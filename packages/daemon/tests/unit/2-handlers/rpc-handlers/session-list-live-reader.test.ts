import { expect, mock, test } from 'bun:test';
import { NAMED_QUERY_REGISTRY } from '../../../../src/lib/live-query/registry';
import type { TableChangeScope } from '../../../../src/storage/reactive-database';
import type { Database } from '../../../../src/storage/sqlite-compat';

test.each([
  [{}, true],
  [{ sessionId: 'unknown-session' }, true],
  [{ sessionId: 'deleted-session', sessionType: 'worker' }, true],
  [{ sessionId: 'unclassified-space-session' }, true],
  [{ sessionId: 'known-space', spaceId: 'synthetic-space' }, false],
  [{ sessionId: 'known-room', roomId: 'synthetic-room' }, false],
  [{ sessionType: 'space_chat' }, false],
  [{ sessionType: 'lobby' }, false],
] as [TableChangeScope, boolean][])(
  'session list invalidation is conservative and SQL-free for %j',
  (scope, expected) => {
    const prepare = mock(() => {
      throw new Error('session list invalidation must not query the main connection');
    });
    const filter = NAMED_QUERY_REGISTRY.get('sessions.list')!.buildScopeFilter!([0], {
      prepare,
    } as unknown as Database)!;
    expect(filter(scope)).toBe(expected);
    expect(prepare).not.toHaveBeenCalled();
  }
);
