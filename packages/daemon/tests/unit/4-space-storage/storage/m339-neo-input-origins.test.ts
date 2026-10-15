import { describe, expect, test } from 'bun:test';
import { runMigration339 } from '../../../../src/storage/schema/m339-neo-input-origins';
import { runMigration377 } from '../../../../src/storage/schema/m377-neo-input-origin-trigger';
import { NeoInputOriginRepository } from '../../../../src/storage/repositories/neo-input-origin-repository';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration339', () => {
  test('creates the input origin stamps once, and the first stamp for an input wins', () => {
    const db = new Database(':memory:');
    const repo = new NeoInputOriginRepository(db);
    expect(repo.get('neo:root', 'note-1')).toBeNull();
    runMigration339(db);
    runMigration339(db);
    runMigration377(db);
    const input = { sessionId: 'neo:root', messageId: 'note-1' };
    repo.record(input, { sessionId: 'neo:root', messageId: 'human-1' }, 1);
    repo.record(input, { sessionId: 'neo:root', messageId: 'human-2' }, 2);
    expect(repo.get('neo:root', 'note-1')).toEqual({ sessionId: 'neo:root', messageId: 'human-1' });
    expect(repo.get('neo:root', 'note-2')).toBeNull();
  });
});

describe('runMigration377', () => {
  test('adds the trigger to each input stamp once, and an input without one reads null', () => {
    const db = new Database(':memory:');
    const repo = new NeoInputOriginRepository(db);
    runMigration377(db);
    runMigration339(db);
    runMigration377(db);
    runMigration377(db);
    const origin = { sessionId: 'neo:root', messageId: 'human-1' };
    repo.record({ sessionId: 'neo:root', messageId: 'note-1' }, origin, 1, 'human:human-1');
    repo.record({ sessionId: 'neo:root', messageId: 'note-2' }, origin, 1);
    expect(repo.trigger('neo:root', 'note-1')).toBe('human:human-1');
    expect(repo.trigger('neo:root', 'note-2')).toBeNull();
    expect(repo.trigger('neo:root', 'note-3')).toBeNull();
  });
});
