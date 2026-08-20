import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { LiveQueryEngine, computeDiff, extractTables } from '../../../../src/storage/live-query';
import type { QueryDiff } from '../../../../src/storage/live-query';

interface MockReactiveDatabase {
  on(
    event: 'change',
    listener: (data: { tables: string[]; versions: Record<string, number> }) => void
  ): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  getTableVersion(table: string): number;
  fireChange(tables: string[]): void;
  bumpAndFire(table: string): void;
}

function createMockReactiveDatabase(): MockReactiveDatabase {
  const emitter = new EventEmitter();
  const versions: Record<string, number> = {};

  return {
    on(
      event: 'change',
      listener: (data: { tables: string[]; versions: Record<string, number> }) => void
    ): void {
      emitter.on(event, listener);
    },
    off(event: string, listener: (...args: unknown[]) => void): void {
      emitter.off(event, listener);
    },
    getTableVersion(table: string): number {
      return versions[table] ?? 0;
    },
    fireChange(tables: string[]): void {
      const v: Record<string, number> = {};
      for (const t of tables) {
        v[t] = versions[t] ?? 0;
      }
      emitter.emit('change', { tables, versions: v });
    },
    bumpAndFire(table: string): void {
      versions[table] = (versions[table] ?? 0) + 1;
      this.fireChange([table]);
    },
  };
}

function createTestDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec(`
		CREATE TABLE items (
			id   TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			val  INTEGER DEFAULT 0
		);
		CREATE TABLE other (
			id TEXT PRIMARY KEY,
			note TEXT
		);
	`);
  return db;
}

function insertItem(db: BunDatabase, id: string, name: string, val = 0): void {
  db.exec(`INSERT INTO items (id, name, val) VALUES ('${id}', '${name}', ${val})`);
}

function updateItem(db: BunDatabase, id: string, name: string, val: number): void {
  db.exec(`UPDATE items SET name = '${name}', val = ${val} WHERE id = '${id}'`);
}

function deleteItem(db: BunDatabase, id: string): void {
  db.exec(`DELETE FROM items WHERE id = '${id}'`);
}

describe('LiveQueryEngine', () => {
  let db: BunDatabase;
  let mockReactive: MockReactiveDatabase;
  let engine: LiveQueryEngine;

  const SQL = 'SELECT id, name, val FROM items ORDER BY id';

  beforeEach(() => {
    db = createTestDb();
    mockReactive = createMockReactiveDatabase();
    engine = new LiveQueryEngine(
      db,
      mockReactive as Parameters<
        (typeof LiveQueryEngine)['prototype']['subscribe']
      >[2] extends never
        ? never
        : any
    );
  });

  afterEach(() => {
    engine.dispose();
    db.close();
  });

  describe('subscribe — initial snapshot', () => {
    test('delivers snapshot immediately on subscribe with empty table', () => {
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      expect(diffs.length).toBe(1);
      expect(diffs[0].type).toBe('snapshot');
      expect(diffs[0].rows).toEqual([]);
    });

    test('snapshot contains existing rows when table already has data', () => {
      insertItem(db, 'a', 'Alpha', 1);
      insertItem(db, 'b', 'Beta', 2);

      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      expect(diffs[0].type).toBe('snapshot');
      expect(diffs[0].rows.length).toBe(2);
      expect(diffs[0].rows[0].id).toBe('a');
      expect(diffs[0].rows[1].id).toBe('b');
    });

    test('snapshot version is 0 when table version is 0', () => {
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      expect(diffs[0].version).toBe(0);
    });
  });

  describe('INSERT triggers delta', () => {
    test('delta has type=delta after insert', async () => {
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      insertItem(db, 'c', 'Charlie', 3);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      expect(diffs.length).toBe(2);
      expect(diffs[1].type).toBe('delta');
    });

    test('delta added contains the new row', async () => {
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      insertItem(db, 'd', 'Delta', 4);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.added?.length).toBe(1);
      expect(delta.added?.[0].id).toBe('d');
      expect(delta.added?.[0].name).toBe('Delta');
      expect(delta.added?.[0].val).toBe(4);
    });

    test('delta rows contains all current rows after insert', async () => {
      insertItem(db, 'e', 'Echo', 5);
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      insertItem(db, 'f', 'Foxtrot', 6);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      expect(diffs[1].rows.length).toBe(2);
    });

    test('handle.get() returns updated rows after insert delta', async () => {
      const handle = engine.subscribe(SQL, [], () => {});

      insertItem(db, 'g', 'Golf', 7);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      expect(handle.get().length).toBe(1);
      expect(handle.get()[0].id).toBe('g');
    });
  });

  describe('debounced reevaluation', () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    test('coalesces multiple table changes into one latest-state delta', async () => {
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff), { debounceMs: 20 });

      insertItem(db, 'a', 'Alpha', 1);
      mockReactive.bumpAndFire('items');
      insertItem(db, 'b', 'Beta', 2);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();
      expect(diffs.length).toBe(1);

      await wait(35);
      expect(diffs.length).toBe(2);
      expect(diffs[1].type).toBe('delta');
      expect(diffs[1].added?.map((row) => row.id).sort()).toEqual(['a', 'b']);
    });

    test('clears pending debounced evaluations when last subscriber disposes', async () => {
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      const handle = engine.subscribe(SQL, [], (diff) => diffs.push(diff), { debounceMs: 20 });

      insertItem(db, 'a', 'Alpha', 1);
      mockReactive.bumpAndFire('items');
      handle.dispose();

      await wait(35);
      expect(diffs.length).toBe(1);
    });
  });

  describe('UPDATE triggers delta', () => {
    test('delta updated contains the modified row', async () => {
      insertItem(db, 'h', 'Hotel', 8);
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      updateItem(db, 'h', 'Hotel-Updated', 99);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.type).toBe('delta');
      expect(delta.updated?.length).toBe(1);
      expect(delta.updated?.[0].name).toBe('Hotel-Updated');
      expect(delta.updated?.[0].val).toBe(99);
    });

    test('delta added and removed are empty on pure update', async () => {
      insertItem(db, 'i', 'India', 9);
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      updateItem(db, 'i', 'India-New', 10);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.added).toEqual([]);
      expect(delta.removed).toEqual([]);
    });
  });

  describe('DELETE triggers delta', () => {
    test('delta removed contains the deleted row', async () => {
      insertItem(db, 'j', 'Juliet', 10);
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      deleteItem(db, 'j');
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.type).toBe('delta');
      expect(delta.removed?.length).toBe(1);
      expect(delta.removed?.[0].id).toBe('j');
    });

    test('delta rows is empty after deleting the only row', async () => {
      insertItem(db, 'k', 'Kilo', 11);
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      deleteItem(db, 'k');
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      expect(diffs[1].rows).toEqual([]);
    });
  });

  describe('no callback on unrelated table change', () => {
    test('writing to an unrelated table does NOT trigger a delta', async () => {
      insertItem(db, 'l', 'Lima', 12);
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      db.exec(`INSERT INTO other (id, note) VALUES ('x', 'unrelated')`);
      mockReactive.bumpAndFire('other');

      await Promise.resolve();

      expect(diffs.length).toBe(1);
    });

    test('change event for items table but no data change does NOT trigger a delta', async () => {
      insertItem(db, 'm', 'Mike', 13);
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      expect(diffs.length).toBe(1);
    });
  });

  describe('multiple subscribers', () => {
    test('two subscribers to same query both receive initial snapshot', () => {
      const diffs1: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      const diffs2: QueryDiff<{ id: string; name: string; val: number }>[] = [];

      engine.subscribe(SQL, [], (diff) => diffs1.push(diff));
      engine.subscribe(SQL, [], (diff) => diffs2.push(diff));

      expect(diffs1.length).toBe(1);
      expect(diffs2.length).toBe(1);
      expect(diffs1[0].type).toBe('snapshot');
      expect(diffs2[0].type).toBe('snapshot');
    });

    test('both subscribers receive delta after insert', async () => {
      const diffs1: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      const diffs2: QueryDiff<{ id: string; name: string; val: number }>[] = [];

      engine.subscribe(SQL, [], (diff) => diffs1.push(diff));
      engine.subscribe(SQL, [], (diff) => diffs2.push(diff));

      insertItem(db, 'n', 'November', 14);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      expect(diffs1.length).toBe(2);
      expect(diffs2.length).toBe(2);
      expect(diffs1[1].type).toBe('delta');
      expect(diffs2[1].type).toBe('delta');
    });

    test('different queries with overlapping tables each get their own callbacks', async () => {
      const sqlAll = 'SELECT id, name, val FROM items ORDER BY id';
      const sqlFiltered = 'SELECT id, name, val FROM items WHERE val > 50 ORDER BY id';

      const allDiffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      const filteredDiffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];

      engine.subscribe(sqlAll, [], (diff) => allDiffs.push(diff));
      engine.subscribe(sqlFiltered, [], (diff) => filteredDiffs.push(diff));

      insertItem(db, 'o', 'Oscar', 5);
      mockReactive.bumpAndFire('items');
      await Promise.resolve();

      expect(allDiffs.length).toBe(2);
      expect(filteredDiffs.length).toBe(1);
    });

    test('shared query metadata is computed once and delivered to all subscribers', async () => {
      const diffs1: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      const diffs2: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      let metadataCalls = 0;

      const getMetadata = (rows: Record<string, unknown>[]) => {
        metadataCalls += 1;
        return { count: rows.length };
      };

      engine.subscribe(SQL, [], (diff) => diffs1.push(diff), { getMetadata });
      engine.subscribe(SQL, [], (diff) => diffs2.push(diff), { getMetadata });

      expect(metadataCalls).toBe(1);
      expect(diffs1[0].metadata).toEqual({ count: 0 });
      expect(diffs2[0].metadata).toEqual({ count: 0 });

      insertItem(db, 'shared', 'Shared', 1);
      mockReactive.bumpAndFire('items');
      await Promise.resolve();

      expect(metadataCalls).toBe(2);
      expect(diffs1[1].metadata).toEqual({ count: 1 });
      expect(diffs2[1].metadata).toEqual({ count: 1 });
    });

    test('metadata-only changes emit deltas and refresh later snapshots', async () => {
      insertItem(db, 'meta', 'Metadata', 1);

      const sqlWithSideTable = `
				SELECT items.id, items.name, items.val
				FROM items
				LEFT JOIN other ON other.id = '__never_matches__'
				ORDER BY items.id
			`;
      const diffs1: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      const diffs2: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      let metadataCalls = 0;

      const getMetadata = () => {
        metadataCalls += 1;
        const row = db.prepare('SELECT COUNT(*) AS count FROM other').get() as { count: number };
        return { sideCount: row.count };
      };

      engine.subscribe(sqlWithSideTable, [], (diff) => diffs1.push(diff), { getMetadata });

      expect(metadataCalls).toBe(1);
      expect(diffs1[0].metadata).toEqual({ sideCount: 0 });

      db.exec(`INSERT INTO other (id, note) VALUES ('side', 'side metadata')`);
      mockReactive.bumpAndFire('other');
      await Promise.resolve();

      expect(metadataCalls).toBe(2);
      expect(diffs1.length).toBe(2);
      expect(diffs1[1].type).toBe('delta');
      expect(diffs1[1].rows).toEqual(diffs1[0].rows);
      expect(diffs1[1].added).toEqual([]);
      expect(diffs1[1].removed).toEqual([]);
      expect(diffs1[1].updated).toEqual([]);
      expect(diffs1[1].metadata).toEqual({ sideCount: 1 });

      engine.subscribe(sqlWithSideTable, [], (diff) => diffs2.push(diff), { getMetadata });

      expect(metadataCalls).toBe(2);
      expect(diffs2[0].type).toBe('snapshot');
      expect(diffs2[0].metadata).toEqual({ sideCount: 1 });
    });
  });

  describe('rowFingerprint — lightweight change detection', () => {
    const FINGERPRINT = (row: Record<string, unknown>) => ({
      name: typeof row.name === 'string' ? row.name.length : row.name,
      val: row.val,
    });

    test('content-length fingerprint detects a content rewrite (updated)', async () => {
      insertItem(db, 'a', 'alpha', 1);
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff), { rowFingerprint: FINGERPRINT });

      updateItem(db, 'a', 'alpha-expanded', 1);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.type).toBe('delta');
      expect(delta.updated?.length).toBe(1);
      expect(delta.updated?.[0].id).toBe('a');
      expect(delta.updated?.[0].name).toBe('alpha-expanded');
    });

    test('rowFingerprint emits no delta when the fingerprint is unchanged', async () => {
      insertItem(db, 'a', 'alpha', 1);
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff), { rowFingerprint: FINGERPRINT });

      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      expect(diffs.length).toBe(1);
    });

    test('rowFingerprint detects a change in a watched column', async () => {
      insertItem(db, 'a', 'alpha', 1);
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff), { rowFingerprint: FINGERPRINT });

      updateItem(db, 'a', 'alpha', 99);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.updated?.length).toBe(1);
      expect(delta.updated?.[0].val).toBe(99);
    });

    test('rowFingerprint ignores columns excluded from the fingerprint', async () => {
      const nameOnly = (row: Record<string, unknown>) => ({
        name: typeof row.name === 'string' ? row.name.length : row.name,
      });
      insertItem(db, 'a', 'alpha', 1);
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff), { rowFingerprint: nameOnly });

      updateItem(db, 'a', 'alpha', 99);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      expect(diffs.length).toBe(1);
    });

    test('rowFingerprint preserves added and removed semantics', async () => {
      insertItem(db, 'a', 'alpha', 1);
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff), { rowFingerprint: FINGERPRINT });

      insertItem(db, 'b', 'beta', 2);
      deleteItem(db, 'a');
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.added?.map((row) => row.id)).toEqual(['b']);
      expect(delta.removed?.map((row) => row.id)).toEqual(['a']);
    });

    test('rowFingerprint is ignored on the no-id positional path', async () => {
      db.exec('CREATE TABLE fp_metrics (name TEXT, value INTEGER)');
      db.exec(`INSERT INTO fp_metrics (name, value) VALUES ('cpu', 42)`);
      const diffs: QueryDiff<{ name: string; value: number }>[] = [];
      engine.subscribe(
        'SELECT name, value FROM fp_metrics ORDER BY name',
        [],
        (diff) => diffs.push(diff),
        { rowFingerprint: FINGERPRINT }
      );

      db.exec(`UPDATE fp_metrics SET value = 99 WHERE name = 'cpu'`);
      mockReactive.bumpAndFire('fp_metrics');

      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.updated).toEqual([]);
      expect(delta.removed).toEqual([{ name: 'cpu', value: 42 }]);
      expect(delta.added).toEqual([{ name: 'cpu', value: 99 }]);
    });

    test('rewrite-able rows are hashed in full so same-length content edits still diff', async () => {
      db.exec(
        'CREATE TABLE fp_rewriteable (id TEXT PRIMARY KEY, content TEXT, rewriteable INTEGER)'
      );
      db.exec(
        `INSERT INTO fp_rewriteable (id, content, rewriteable) VALUES ('r1', 'payload-a', 1)`
      );
      const fingerprint = (row: Record<string, unknown>) =>
        row.rewriteable === 1 ? row : { content: row.content.length };
      const diffs: QueryDiff<{ id: string; content: string; rewriteable: number }>[] = [];
      engine.subscribe(
        'SELECT id, content, rewriteable FROM fp_rewriteable ORDER BY id',
        [],
        (diff) => diffs.push(diff),
        { rowFingerprint: fingerprint }
      );

      db.exec(`UPDATE fp_rewriteable SET content = 'payload-b' WHERE id = 'r1'`);
      mockReactive.bumpAndFire('fp_rewriteable');

      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.type).toBe('delta');
      expect(delta.updated?.length).toBe(1);
      expect(delta.updated?.[0].content).toBe('payload-b');
    });

    test('immutable rows skip same-length content edits via the length fingerprint', async () => {
      db.exec('CREATE TABLE fp_immutable (id TEXT PRIMARY KEY, content TEXT, rewriteable INTEGER)');
      db.exec(`INSERT INTO fp_immutable (id, content, rewriteable) VALUES ('n1', 'payload-a', 0)`);
      const fingerprint = (row: Record<string, unknown>) =>
        row.rewriteable === 1 ? row : { content: row.content.length };
      const diffs: QueryDiff<{ id: string; content: string; rewriteable: number }>[] = [];
      engine.subscribe(
        'SELECT id, content, rewriteable FROM fp_immutable ORDER BY id',
        [],
        (diff) => diffs.push(diff),
        { rowFingerprint: fingerprint }
      );

      db.exec(`UPDATE fp_immutable SET content = 'payload-b' WHERE id = 'n1'`);
      mockReactive.bumpAndFire('fp_immutable');

      await Promise.resolve();

      expect(diffs.length).toBe(1);
    });
  });

  describe('handle.dispose()', () => {
    test('disposed handle no longer receives deltas', async () => {
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      const handle = engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      handle.dispose();

      insertItem(db, 'p', 'Papa', 16);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      expect(diffs.length).toBe(1);
    });

    test('disposing one handle does not affect another subscriber', async () => {
      const diffs1: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      const diffs2: QueryDiff<{ id: string; name: string; val: number }>[] = [];

      const handle1 = engine.subscribe(SQL, [], (diff) => diffs1.push(diff));
      engine.subscribe(SQL, [], (diff) => diffs2.push(diff));

      handle1.dispose();

      insertItem(db, 'q', 'Quebec', 17);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      expect(diffs1.length).toBe(1);
      expect(diffs2.length).toBe(2);
    });

    test('handle.get() still returns last known rows after dispose (stale read)', async () => {
      insertItem(db, 'stale1', 'Stale', 1);
      const handle = engine.subscribe(SQL, [], () => {});

      expect(handle.get().length).toBe(1);
      expect(handle.get()[0].id).toBe('stale1');

      handle.dispose();

      expect(handle.get().length).toBe(1);
      expect(handle.get()[0].id).toBe('stale1');

      insertItem(db, 'stale2', 'Stale2', 2);
      mockReactive.bumpAndFire('items');
      await Promise.resolve();

      expect(handle.get().length).toBe(1);
    });
  });

  describe('LiveQueryEngine.dispose()', () => {
    test('disposed engine does not deliver further deltas', async () => {
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      engine.dispose();

      insertItem(db, 'r', 'Romeo', 18);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      expect(diffs.length).toBe(1);
    });

    test('engine.dispose() stops listening even if change events continue to fire', async () => {
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      engine.dispose();

      mockReactive.bumpAndFire('items');
      mockReactive.bumpAndFire('items');
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      expect(diffs.length).toBe(1);
    });
  });

  describe('version in diffs', () => {
    test('delta version reflects ReactiveDatabase table version at evaluation time', async () => {
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      insertItem(db, 's', 'Sierra', 19);
      mockReactive.bumpAndFire('items');

      await Promise.resolve();

      expect(diffs[1].version).toBe(1);
    });

    test('version increases with successive writes', async () => {
      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(SQL, [], (diff) => diffs.push(diff));

      insertItem(db, 't', 'Tango', 20);
      mockReactive.bumpAndFire('items');
      await Promise.resolve();

      insertItem(db, 'u', 'Uniform', 21);
      mockReactive.bumpAndFire('items');
      await Promise.resolve();

      expect(diffs[1].version).toBe(1);
      expect(diffs[2].version).toBe(2);
    });
  });

  describe('parameterised queries', () => {
    test('query with parameter only reacts to matching rows', async () => {
      const sqlParam = 'SELECT id, name, val FROM items WHERE val > ? ORDER BY id';

      insertItem(db, 'v', 'Victor', 5);
      insertItem(db, 'w', 'Whiskey', 50);

      const diffs: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      engine.subscribe(sqlParam, [10], (diff) => diffs.push(diff));

      expect(diffs[0].rows.length).toBe(1);
      expect(diffs[0].rows[0].id).toBe('w');
    });

    test('two subscriptions to same SQL with different params are independent', async () => {
      const sqlParam = 'SELECT id, name, val FROM items WHERE val > ? ORDER BY id';
      insertItem(db, 'x', 'Xray', 100);

      const difsLow: QueryDiff<{ id: string; name: string; val: number }>[] = [];
      const difsHigh: QueryDiff<{ id: string; name: string; val: number }>[] = [];

      engine.subscribe(sqlParam, [10], (diff) => difsLow.push(diff));
      engine.subscribe(sqlParam, [200], (diff) => difsHigh.push(diff));

      expect(difsLow[0].rows.length).toBe(1);
      expect(difsHigh[0].rows.length).toBe(0);
    });
  });

  describe('computeDiff (positional path)', () => {
    test('empty arrays produce empty diff', () => {
      const result = computeDiff([], []);
      expect(result.added).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.updated).toEqual([]);
    });

    test('id-based path: new row appears in added', () => {
      const oldRows = [{ id: '1', val: 10 }];
      const newRows = [
        { id: '1', val: 10 },
        { id: '2', val: 20 },
      ];
      const result = computeDiff(oldRows, newRows);
      expect(result.added).toEqual([{ id: '2', val: 20 }]);
      expect(result.removed).toEqual([]);
      expect(result.updated).toEqual([]);
    });

    test('id-based path: deleted row appears in removed', () => {
      const oldRows = [
        { id: '1', val: 10 },
        { id: '2', val: 20 },
      ];
      const newRows = [{ id: '1', val: 10 }];
      const result = computeDiff(oldRows, newRows);
      expect(result.added).toEqual([]);
      expect(result.removed).toEqual([{ id: '2', val: 20 }]);
      expect(result.updated).toEqual([]);
    });

    test('id-based path: changed row appears in updated', () => {
      const oldRows = [{ id: '1', val: 10 }];
      const newRows = [{ id: '1', val: 99 }];
      const result = computeDiff(oldRows, newRows);
      expect(result.added).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.updated).toEqual([{ id: '1', val: 99 }]);
    });

    test('positional path: updated array is always empty', () => {
      const oldRows = [{ name: 'alpha', value: 1 }];
      const newRows = [{ name: 'alpha', value: 99 }];
      const result = computeDiff(oldRows, newRows);
      expect(result.updated).toEqual([]);
      expect(result.removed).toEqual([{ name: 'alpha', value: 1 }]);
      expect(result.added).toEqual([{ name: 'alpha', value: 99 }]);
    });

    test('positional path: new row with no id appears in added', () => {
      const oldRows = [{ name: 'alpha', value: 1 }];
      const newRows = [
        { name: 'alpha', value: 1 },
        { name: 'beta', value: 2 },
      ];
      const result = computeDiff(oldRows, newRows);
      expect(result.added).toEqual([{ name: 'beta', value: 2 }]);
      expect(result.removed).toEqual([]);
      expect(result.updated).toEqual([]);
    });

    test('positional path: deleted row with no id appears in removed', () => {
      const oldRows = [
        { name: 'alpha', value: 1 },
        { name: 'beta', value: 2 },
      ];
      const newRows = [{ name: 'alpha', value: 1 }];
      const result = computeDiff(oldRows, newRows);
      expect(result.added).toEqual([]);
      expect(result.removed).toEqual([{ name: 'beta', value: 2 }]);
      expect(result.updated).toEqual([]);
    });

    test('positional path: identical rows produce empty diff', () => {
      const rows = [
        { name: 'alpha', value: 1 },
        { name: 'beta', value: 2 },
      ];
      const result = computeDiff(rows, rows.slice());
      expect(result.added).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.updated).toEqual([]);
    });
  });

  describe('positional diff path — integration via metrics table', () => {
    const METRICS_SQL = 'SELECT name, value FROM metrics ORDER BY name';

    beforeEach(() => {
      db.exec('CREATE TABLE metrics (name TEXT, value INTEGER)');
    });

    test('initial snapshot is empty for empty metrics table', () => {
      const diffs: QueryDiff<{ name: string; value: number }>[] = [];
      engine.subscribe(METRICS_SQL, [], (diff) => diffs.push(diff));

      expect(diffs.length).toBe(1);
      expect(diffs[0].type).toBe('snapshot');
      expect(diffs[0].rows).toEqual([]);
    });

    test('insert into metrics produces delta with added row', async () => {
      const diffs: QueryDiff<{ name: string; value: number }>[] = [];
      engine.subscribe(METRICS_SQL, [], (diff) => diffs.push(diff));

      db.exec(`INSERT INTO metrics (name, value) VALUES ('cpu', 42)`);
      mockReactive.bumpAndFire('metrics');
      await Promise.resolve();

      expect(diffs.length).toBe(2);
      const delta = diffs[1];
      expect(delta.type).toBe('delta');
      expect(delta.added).toEqual([{ name: 'cpu', value: 42 }]);
      expect(delta.removed).toEqual([]);
    });

    test('positional diff never produces updated entries on metrics table', async () => {
      db.exec(`INSERT INTO metrics (name, value) VALUES ('cpu', 42)`);
      const diffs: QueryDiff<{ name: string; value: number }>[] = [];
      engine.subscribe(METRICS_SQL, [], (diff) => diffs.push(diff));

      db.exec(`UPDATE metrics SET value = 99 WHERE name = 'cpu'`);
      mockReactive.bumpAndFire('metrics');
      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.updated).toEqual([]);
      expect(delta.removed).toEqual([{ name: 'cpu', value: 42 }]);
      expect(delta.added).toEqual([{ name: 'cpu', value: 99 }]);
    });

    test('delete from metrics produces delta with removed row', async () => {
      db.exec(`INSERT INTO metrics (name, value) VALUES ('mem', 10)`);
      const diffs: QueryDiff<{ name: string; value: number }>[] = [];
      engine.subscribe(METRICS_SQL, [], (diff) => diffs.push(diff));

      db.exec(`DELETE FROM metrics WHERE name = 'mem'`);
      mockReactive.bumpAndFire('metrics');
      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.type).toBe('delta');
      expect(delta.removed).toEqual([{ name: 'mem', value: 10 }]);
      expect(delta.added).toEqual([]);
      expect(delta.updated).toEqual([]);
    });

    test('unchanged metrics table fires no delta callback', async () => {
      db.exec(`INSERT INTO metrics (name, value) VALUES ('disk', 5)`);
      const diffs: QueryDiff<{ name: string; value: number }>[] = [];
      engine.subscribe(METRICS_SQL, [], (diff) => diffs.push(diff));

      mockReactive.bumpAndFire('metrics');
      await Promise.resolve();

      expect(diffs.length).toBe(1);
    });
  });

  describe('JOIN query — engine reacts to joined table changes', () => {
    const JOIN_SQL = `
			SELECT items.id, items.name, other.note
			FROM items
			JOIN other ON items.id = other.id
			ORDER BY items.id
		`;

    test('initial snapshot includes joined rows', () => {
      db.exec(`INSERT INTO items (id, name, val) VALUES ('z1', 'Zulu', 1)`);
      db.exec(`INSERT INTO other (id, note) VALUES ('z1', 'note-z1')`);

      const diffs: QueryDiff<{ id: string; name: string; note: string }>[] = [];
      engine.subscribe(JOIN_SQL, [], (diff) => diffs.push(diff));

      expect(diffs[0].type).toBe('snapshot');
      expect(diffs[0].rows.length).toBe(1);
      expect(diffs[0].rows[0].id).toBe('z1');
      expect(diffs[0].rows[0].note).toBe('note-z1');
    });

    test('change to joined `other` table triggers delta', async () => {
      db.exec(`INSERT INTO items (id, name, val) VALUES ('z2', 'Zulu2', 2)`);
      db.exec(`INSERT INTO other (id, note) VALUES ('z2', 'old-note')`);

      const diffs: QueryDiff<{ id: string; name: string; note: string }>[] = [];
      engine.subscribe(JOIN_SQL, [], (diff) => diffs.push(diff));

      db.exec(`UPDATE other SET note = 'new-note' WHERE id = 'z2'`);
      mockReactive.bumpAndFire('other');
      await Promise.resolve();

      expect(diffs.length).toBe(2);
      expect(diffs[1].type).toBe('delta');
      expect(diffs[1].updated?.[0]?.note).toBe('new-note');
    });

    test('change to `items` table also triggers delta for join query', async () => {
      db.exec(`INSERT INTO items (id, name, val) VALUES ('z3', 'Zulu3', 3)`);
      db.exec(`INSERT INTO other (id, note) VALUES ('z3', 'note-z3')`);

      const diffs: QueryDiff<{ id: string; name: string; note: string }>[] = [];
      engine.subscribe(JOIN_SQL, [], (diff) => diffs.push(diff));

      db.exec(`UPDATE items SET name = 'Zulu3-Updated' WHERE id = 'z3'`);
      mockReactive.bumpAndFire('items');
      await Promise.resolve();

      expect(diffs.length).toBe(2);
      expect(diffs[1].type).toBe('delta');
      expect(diffs[1].updated?.[0]?.name).toBe('Zulu3-Updated');
    });
  });
});

describe('extractTables', () => {
  test('simple FROM extracts single table', () => {
    expect(extractTables('SELECT * FROM items')).toEqual(['items']);
  });

  test('FROM keyword is case-insensitive', () => {
    expect(extractTables('SELECT * from ITEMS')).toEqual(['items']);
  });

  test('table name is normalised to lowercase', () => {
    expect(extractTables('SELECT * FROM ITEMS')).toEqual(['items']);
  });

  test('plain JOIN extracts table', () => {
    const tables = extractTables('SELECT * FROM items JOIN other ON items.id = other.id');
    expect(tables).toContain('items');
    expect(tables).toContain('other');
  });

  test('LEFT JOIN extracts table', () => {
    const tables = extractTables('SELECT * FROM items LEFT JOIN other ON items.id = other.id');
    expect(tables).toContain('other');
  });

  test('RIGHT JOIN extracts table', () => {
    const tables = extractTables('SELECT * FROM items RIGHT JOIN other ON items.id = other.id');
    expect(tables).toContain('other');
  });

  test('INNER JOIN extracts table', () => {
    const tables = extractTables('SELECT * FROM items INNER JOIN other ON items.id = other.id');
    expect(tables).toContain('other');
  });

  test('CROSS JOIN extracts table', () => {
    const tables = extractTables('SELECT * FROM items CROSS JOIN other');
    expect(tables).toContain('other');
  });

  test('LEFT OUTER JOIN extracts table', () => {
    const tables = extractTables(
      'SELECT * FROM items LEFT OUTER JOIN other ON items.id = other.id'
    );
    expect(tables).toContain('other');
  });

  test('RIGHT OUTER JOIN extracts table', () => {
    const tables = extractTables(
      'SELECT * FROM items RIGHT OUTER JOIN other ON items.id = other.id'
    );
    expect(tables).toContain('other');
  });

  test('JOIN keywords are case-insensitive', () => {
    const tables = extractTables('select * from items left join other on items.id = other.id');
    expect(tables).toContain('items');
    expect(tables).toContain('other');
  });

  test('comma-separated FROM clause extracts both tables', () => {
    const tables = extractTables('SELECT * FROM items, other WHERE items.id = other.id');
    expect(tables).toContain('items');
    expect(tables).toContain('other');
  });

  test('FROM items AS i extracts items (not i)', () => {
    const tables = extractTables('SELECT i.id FROM items AS i WHERE i.val > 0');
    expect(tables).toContain('items');
    expect(tables).not.toContain('i');
  });

  test('FROM items i (no AS) extracts items (not i)', () => {
    const tables = extractTables('SELECT i.id FROM items i WHERE i.val > 0');
    expect(tables).toContain('items');
    expect(tables).not.toContain('i');
  });

  test('self-join produces single entry for the table', () => {
    const tables = extractTables('SELECT a.id FROM items a JOIN items b ON a.id = b.parent_id');
    expect(tables).toEqual(['items']);
  });

  test('multiple tables via JOIN all extracted', () => {
    const tables = extractTables('SELECT * FROM items JOIN other ON items.id = other.item_id');
    expect(tables.sort()).toEqual(['items', 'other']);
  });

  test('subquery in FROM — inner table is still extracted', () => {
    const sql = 'SELECT * FROM (SELECT * FROM items) AS sub';
    const tables = extractTables(sql);
    expect(tables).toContain('items');
  });

  test('subquery in FROM — outer pseudo-table alias is not extracted', () => {
    const sql = 'SELECT * FROM (SELECT * FROM items) AS sub';
    const tables = extractTables(sql);
    expect(tables).not.toContain('sub');
  });
});
