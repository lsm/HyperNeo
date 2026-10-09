import { describe, expect, test } from 'bun:test';
import { Database as Sqlite } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import type { Database } from '../../../../src/storage/database';
import { neoQueryContext } from '../../../../src/lib/neo/session-policy.ts';

function database(): Database {
  const sqlite = new Sqlite(':memory:');
  runMigrations(sqlite, () => {});
  createTables(sqlite);
  return { getDatabase: () => sqlite } as unknown as Database;
}

describe('neoQueryContext', () => {
  test('is empty without a database', () => {
    expect(neoQueryContext({ sessionId: 'neo:a', concernId: null, kind: 'neo' }, undefined)).toBe(
      ''
    );
  });

  test('reads an empty context for both coordinator kinds when nothing was routed', () => {
    const db = database();
    expect(neoQueryContext({ sessionId: 'neo:a', concernId: null, kind: 'neo' }, db)).toBe('');
    expect(neoQueryContext({ sessionId: 'neo:b', concernId: 'c', kind: 'concern' }, db)).toBe('');
  });
});
