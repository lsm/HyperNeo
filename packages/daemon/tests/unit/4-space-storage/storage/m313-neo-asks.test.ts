import { describe, expect, test } from 'bun:test';
import { NeoAskRepository } from '../../../../src/storage/repositories/neo-ask-repository';
import { runMigration313 } from '../../../../src/storage/schema/m313-neo-asks';
import { Database } from '../../../../src/storage/sqlite-compat';

function withWork() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
  db.exec("INSERT INTO neo_work VALUES ('w2', 2), ('w1', 1)");
  return db;
}

const input = {
  id: 'a1',
  requestKey: 'root:fix',
  concernId: null,
  originSessionId: 'root',
  originMessageId: 'm1',
  title: 'Fix the login bug',
  ask: 'Fix the login bug',
  doneWhen: '- merged to dev',
  doneSource: 'human',
};

describe('runMigration313', () => {
  test('creates the ask tables once, and skips databases without Neo work', () => {
    const db = withWork();
    runMigration313(db);
    runMigration313(db);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name IN ('neo_asks', 'neo_ask_work')").all()
    ).toHaveLength(2);

    const bare = new Database(':memory:');
    runMigration313(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_asks'").get()).toBe(null);
  });
});

describe('NeoAskRepository', () => {
  test('opens one ask per request key and lists its cards in creation order', () => {
    const db = withWork();
    runMigration313(db);
    const asks = new NeoAskRepository(db);

    expect(asks.open(input)).toMatchObject({ id: 'a1', status: 'open', workIds: [] });
    expect(asks.open({ ...input, id: 'a2', title: 'Other' })).toMatchObject({
      id: 'a1',
      title: 'Fix the login bug',
    });
    asks.link('a1', 'w2');
    asks.link('a1', 'w1');
    asks.link('a1', 'w1');

    expect(asks.get('a1')?.workIds).toEqual(['w1', 'w2']);
    expect(asks.list(null).map((ask) => ask.id)).toEqual(['a1']);
    expect(asks.list('other')).toEqual([]);
  });

  test('reads nothing before the migration has run', () => {
    const asks = new NeoAskRepository(withWork());
    expect(asks.open(input)).toBe(null);
    expect(asks.list()).toEqual([]);
  });
});
