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
import { runMigration352 } from '../../../../src/storage/schema/m352-neo-ask-item-watch';
import { runMigration358 } from '../../../../src/storage/schema/m358-neo-ask-revisions';
import { runMigration364 } from '../../../../src/storage/schema/m364-neo-outcome-bindings';
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
    runMigration352,
    runMigration358,
    runMigration364,
  ])
    migrate(db);
  return db;
}

const input = {
  id: 'a1',
  requestKey: 'root:fix',
  projectId: null,
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

describe('NeoAskRepository outcome bindings', () => {
  function fixture() {
    const db = withAsks();
    db.exec("ALTER TABLE neo_work ADD COLUMN status TEXT NOT NULL DEFAULT 'proposed'");
    db.exec('CREATE TABLE neo_work_driver_targets (work_id TEXT, started_at INTEGER)');
    db.exec('CREATE TABLE neo_work_continues (work_id TEXT, stalled INTEGER, progress TEXT)');
    const asks = new NeoAskRepository(db);
    asks.open(input, [{ text: 'Deliver outcome', check: null, watch: ['record:1'] }]);
    asks.open({ ...input, id: 'a2', requestKey: 'target' }, [{ text: 'Other', check: null }]);
    asks.link('a1', 'w1');
    asks.link('a2', 'w2');
    const bindings = [{ itemId: 'i1', deliveredBy: 'w1' }];
    const verify = () => {
      const item = asks.get('a1')!.doneItems![0];
      asks.tickItem(
        'a1',
        { ...item, state: 'met', evidence: 'Independent proof', metBy: 'daemon' },
        10,
        item,
        true
      );
    };
    return { db, asks, bindings, verify };
  }

  test('persists binding, invalidates evidence and approval once, and rejects stale writes', () => {
    const { db, asks, bindings, verify } = fixture();
    try {
      verify();
      asks.approve('a1', 10, 0);
      expect(asks.bindItems('a1', bindings, 0, 11)).toEqual({ ok: true });
      expect(asks.get('a1')).toMatchObject({
        revision: 1,
        approvedAt: null,
        approvedRevision: null,
        doneItems: [
          {
            deliveredBy: 'w1',
            state: 'pending',
            evidence: null,
            metBy: null,
            verifiedDefinitionHash: null,
          },
        ],
      });
      verify();
      asks.approve('a1', 12, 1);
      const before = asks.get('a1');
      expect(asks.bindItems('a1', bindings, 1, 13)).toEqual({ ok: true });
      expect(asks.get('a1')).toEqual(before);
      expect(asks.bindItems('a1', [{ itemId: 'i1', deliveredBy: null }], 0, 14)).toEqual({
        ok: false,
        reason: 'stale_ask_revision',
      });
      expect(asks.get('a1')).toEqual(before);
      expect(asks.bindItems('a1', [{ itemId: 'i1', deliveredBy: null }], 1, 15)).toEqual({
        ok: true,
      });
      expect(asks.get('a1')).toMatchObject({
        revision: 2,
        doneItems: [{ deliveredBy: null, state: 'pending', evidence: null }],
      });
    } finally {
      db.close();
    }
  });

  test('an in-flight verification cannot certify a newly changed binding', () => {
    const { db, asks, bindings } = fixture();
    try {
      const stale = asks.get('a1')!.doneItems![0];
      asks.bindItems('a1', bindings, 0, 11);
      expect(
        asks.tickItem(
          'a1',
          { ...stale, state: 'met', evidence: 'old proof', metBy: 'daemon' },
          12,
          stale,
          true
        )
      ).toBe(false);
      expect(asks.get('a1')!.doneItems![0]).toMatchObject({
        state: 'pending',
        verifiedDefinitionHash: null,
      });
    } finally {
      db.close();
    }
  });

  test('rejects missing and foreign cards, non-outcomes and duplicate items atomically', () => {
    const { db, asks, bindings } = fixture();
    try {
      const before = asks.get('a1');
      for (const deliveredBy of ['absent', 'w2']) {
        expect(asks.bindItems('a1', [{ itemId: 'i1', deliveredBy }], 0, 11)).toEqual({
          ok: false,
          reason: 'binding_card_not_owned',
        });
      }
      for (const inputBindings of [
        [...bindings, ...bindings],
        [...bindings, { itemId: 'missing', deliveredBy: 'w1' }],
      ]) {
        expect(asks.bindItems('a1', inputBindings, 0, 11)).toEqual({
          ok: false,
          reason: 'invalid_outcome_binding',
        });
      }
      expect(asks.get('a1')).toEqual(before);
      for (const column of ['decision = 1', 'removed = 1', "kind = 'wait'"]) {
        db.exec(
          `UPDATE neo_ask_items SET decision = 0, removed = 0, kind = NULL WHERE ask_id = 'a1'`
        );
        db.exec(`UPDATE neo_ask_items SET ${column} WHERE ask_id = 'a1'`);
        expect(asks.bindItems('a1', bindings, 0, 11)).toEqual({
          ok: false,
          reason: 'invalid_outcome_binding',
        });
      }
    } finally {
      db.close();
    }
  });

  test('refuses material bindings once either card is dispatched but allows exact retry', () => {
    const { db, asks, bindings } = fixture();
    try {
      db.exec("INSERT INTO neo_work_driver_targets VALUES ('w1', 4)");
      expect(asks.bindItems('a1', bindings, 0, 11)).toEqual({
        ok: false,
        reason: 'binding_already_dispatched',
      });
      db.exec('DELETE FROM neo_work_driver_targets');
      expect(asks.bindItems('a1', bindings, 0, 12)).toEqual({ ok: true });
      db.exec("UPDATE neo_work SET status = 'queued' WHERE id = 'w1'");
      expect(asks.bindItems('a1', bindings, 1, 13)).toEqual({ ok: true });
      expect(asks.bindItems('a1', [{ itemId: 'i1', deliveredBy: null }], 1, 14)).toEqual({
        ok: false,
        reason: 'binding_already_dispatched',
      });
    } finally {
      db.close();
    }
  });

  test('opt-in fold remaps item IDs, preserves card identity and verified evidence, invalidates target approval', () => {
    const { db, asks, bindings, verify } = fixture();
    try {
      asks.bindItems('a1', bindings, 0, 11);
      verify();
      asks.approve('a1', 12, 1);
      asks.approve('a2', 12, 0);
      const original = asks.get('a1')!.doneItems![0];
      const kept = asks.get('a2')!.doneItems![0];
      expect(
        asks.fold(
          asks.get('a1')!,
          asks.get('a2')!,
          [{ from: 'i1', id: 'i2', position: 1 }],
          'folded',
          13,
          true
        )
      ).toBe(true);
      expect(asks.get('a2')).toMatchObject({
        revision: 1,
        approvedAt: null,
        approvedRevision: null,
        approvedContinues: 0,
        workIds: ['w1', 'w2'],
      });
      expect(asks.get('a2')!.doneItems![0]).toEqual(kept);
      expect(asks.get('a2')!.doneItems![1]).toMatchObject({ ...original, id: 'i2', addedAt: 13 });
      expect(asks.forWork('w1')!.id).toBe('a2');
      expect(asks.get('a1')!.status).toBe('abandoned');
    } finally {
      db.close();
    }
  });

  test('fold clears legacy bound evidence and rolls back invalid item mappings', () => {
    const { db, asks, bindings } = fixture();
    try {
      asks.bindItems('a1', bindings, 0, 11);
      db.exec(
        "UPDATE neo_ask_items SET state = 'met', evidence = 'legacy', met_by = 'daemon' WHERE ask_id = 'a1'"
      );
      for (const moves of [
        [],
        [{ from: 'i1', id: 'i1', position: 1 }],
        [{ from: 'missing', id: 'i2', position: 1 }],
      ]) {
        expect(() =>
          asks.fold(asks.get('a1')!, asks.get('a2')!, moves, 'folded', 13, true)
        ).toThrow('invalid_fold_items');
        expect(asks.get('a1')!.status).toBe('open');
        expect(asks.forWork('w1')!.id).toBe('a1');
      }
      expect(
        asks.fold(
          asks.get('a1')!,
          asks.get('a2')!,
          [{ from: 'i1', id: 'i2', position: 1 }],
          'folded',
          14,
          true
        )
      ).toBe(true);
      expect(asks.get('a2')!.doneItems![1]).toMatchObject({
        deliveredBy: 'w1',
        state: 'pending',
        evidence: null,
        metBy: null,
        verifiedDefinitionHash: null,
      });
    } finally {
      db.close();
    }
  });
});
