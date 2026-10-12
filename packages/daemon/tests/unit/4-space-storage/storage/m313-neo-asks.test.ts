import { describe, expect, test } from 'bun:test';
import { NeoAskRepository } from '../../../../src/storage/repositories/neo-ask-repository';
import { runMigration313 } from '../../../../src/storage/schema/m313-neo-asks';
import { runMigration316 } from '../../../../src/storage/schema/m316-neo-ask-evidence';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration322 } from '../../../../src/storage/schema/m322-neo-ask-reminders';
import { runMigration324 } from '../../../../src/storage/schema/m324-neo-ask-pack';
import { runMigration326 } from '../../../../src/storage/schema/m326-neo-ask-approved';
import { runMigration327 } from '../../../../src/storage/schema/m327-neo-ask-approved-continues';
import { runMigration328 } from '../../../../src/storage/schema/m328-neo-ask-item-check-kinds';
import { runMigration330 } from '../../../../src/storage/schema/m330-neo-ask-waiting-item';
import { runMigration342 } from '../../../../src/storage/schema/m342-neo-ask-item-options';
import { runMigration343 } from '../../../../src/storage/schema/m343-neo-ask-item-decision';
import { runMigration348 } from '../../../../src/storage/schema/m348-neo-ask-item-action';
import { runMigration350 } from '../../../../src/storage/schema/m350-neo-ask-item-kind';
import { runMigration351 } from '../../../../src/storage/schema/m351-neo-ask-item-question';
import { Database } from '../../../../src/storage/sqlite-compat';

function withWork() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
  db.exec("INSERT INTO neo_work VALUES ('w2', 2), ('w1', 1)");
  return db;
}

function withAsks() {
  const db = withWork();
  for (const migrate of [
    runMigration313,
    runMigration316,
    runMigration318,
    runMigration322,
    runMigration324,
    runMigration326,
    runMigration327,
    runMigration328,
    runMigration330,
    runMigration342,
    runMigration343,
    runMigration348,
    runMigration350,
    runMigration351,
  ])
    migrate(db);
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
    const db = withAsks();
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

  test('settles only from the expected status, and new work reopens a blocked ask without its old summary', () => {
    const db = withAsks();
    const asks = new NeoAskRepository(db);
    const opened = asks.open(input)!;

    const blocked = asks.settle(opened, 'blocked', 'Needs you: pick a plan.', 'Two plans fit.')!;
    expect(blocked).toMatchObject({
      status: 'blocked',
      outcome: 'Needs you: pick a plan.',
      evidence: 'Two plans fit.',
    });
    expect(blocked.settledAt).not.toBeNull();
    expect(asks.settle(opened, 'achieved', 'stale', 'stale')).toBe(null);

    asks.link('a1', 'w1');
    expect(asks.get('a1')).toMatchObject({
      status: 'open',
      outcome: null,
      settledAt: null,
      workIds: ['w1'],
    });

    const waiting = asks.settle(asks.get('a1')!, 'waiting', 'Start it?', 'Offered.')!;
    expect(waiting).toMatchObject({ status: 'waiting', outcome: 'Start it?' });
    asks.reopenForWork('w2');
    expect(asks.get('a1')?.status).toBe('waiting');
    asks.reopenForWork('w1');
    expect(asks.get('a1')).toMatchObject({ status: 'open', outcome: null, settledAt: null });
  });

  test('keeps checklist items with the ask that created them, once', () => {
    const db = withAsks();
    runMigration318(db);
    const asks = new NeoAskRepository(db);
    const items = [
      { text: 'Merged', check: 'coding.pr_merged' as const },
      { text: 'Docs', check: null },
    ];
    expect(asks.open(input, items)?.doneItems?.map((item) => [item.id, item.state])).toEqual([
      ['i1', 'pending'],
      ['i2', 'pending'],
    ]);
    expect(
      asks.open({ ...input, id: 'a2' }, [{ text: 'Other', check: null }])?.doneItems
    ).toHaveLength(2);
    expect(() =>
      db.prepare("UPDATE neo_ask_items SET state = 'done' WHERE id = 'i1'").run()
    ).toThrow();
  });
});
