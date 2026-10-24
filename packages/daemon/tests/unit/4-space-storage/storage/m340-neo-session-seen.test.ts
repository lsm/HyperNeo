import { describe, expect, test } from 'bun:test';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import {
  NeoSessionSeenRepository,
  replaceNeoSessionSeen,
} from '../../../../src/storage/repositories/neo-session-seen-repository';
import { runMigration340 } from '../../../../src/storage/schema/m340-neo-session-seen';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration340', () => {
  test('creates the session seen table once', () => {
    const db = new Database(':memory:');
    runMigration340(db);
    runMigration340(db);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_session_seen'").get()
    ).toEqual({ name: 'neo_session_seen' });
  });
});

describe('NeoSessionSeenRepository', () => {
  test('replaces what it saw through the gateway and survives a new repository instance', async () => {
    expect(DB_OPS.get(replaceNeoSessionSeen.name)).toBe(replaceNeoSessionSeen);
    const db = new Database(':memory:');
    runMigration340(db);
    await new NeoSessionSeenRepository(db).replace([
      ['codex::a', { listed: 'running:1', status: 'running' }],
      ['codex::b', { listed: 'done:2', status: 'done' }],
    ]);
    await new NeoSessionSeenRepository(db).replace([
      ['codex::b', { listed: 'failed:3', status: 'failed' }],
    ]);
    expect(new NeoSessionSeenRepository(db).list()).toEqual([
      ['codex::b', { listed: 'failed:3', status: 'failed' }],
    ]);
  });

  test('skips a row whose status is no longer a work status', () => {
    const db = new Database(':memory:');
    runMigration340(db);
    db.exec("INSERT INTO neo_session_seen VALUES ('codex::a', 'x:1', 'retired')");
    expect(new NeoSessionSeenRepository(db).list()).toEqual([]);
  });
});
