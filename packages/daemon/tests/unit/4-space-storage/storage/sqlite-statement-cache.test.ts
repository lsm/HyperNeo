import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { STATEMENT_CACHE_CAPACITY, StatementCache } from '../../../../src/storage/statement-cache';

describe('StatementCache', () => {
  test('returns the same value for the same key', () => {
    const cache = new StatementCache<object>(2);
    const statement = {};
    cache.set('SELECT 1', statement);
    expect(cache.get('SELECT 1')).toBe(statement);
  });

  test('returns undefined for an unknown key', () => {
    const cache = new StatementCache<object>(2);
    expect(cache.get('SELECT 1')).toBeUndefined();
  });

  test('evicts the oldest entry once capacity is exceeded', () => {
    const cache = new StatementCache<object>(2);
    const a = {};
    const b = {};
    const c = {};
    cache.set('a', a);
    cache.set('b', b);
    cache.set('c', c);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(b);
    expect(cache.get('c')).toBe(c);
  });

  test('clear drops all entries', () => {
    const cache = new StatementCache<object>(2);
    cache.set('a', {});
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('sqlite statement caching', () => {
  test('prepare reuses the same statement for identical SQL', () => {
    const db = new Database(':memory:');
    const first = db.prepare('SELECT 1 AS x');
    const second = db.prepare('SELECT 1 AS x');
    expect(second).toBe(first);
    db.close();
  });

  test('prepare returns distinct statements for distinct SQL', () => {
    const db = new Database(':memory:');
    const first = db.prepare('SELECT 1 AS x');
    const second = db.prepare('SELECT 2 AS x');
    expect(second).not.toBe(first);
    db.close();
  });

  test('reused statement rebinds parameters per call', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');
    const insert = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)');
    const select = db.prepare('SELECT v FROM kv WHERE k = ?');
    insert.run('a', 'one');
    insert.run('b', 'two');
    expect((select.get('a') as { v: string }).v).toBe('one');
    expect((select.get('b') as { v: string }).v).toBe('two');
    db.close();
  });

  test('shared statement stays correct across interleaved concurrent flows', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, flow TEXT, seq INTEGER)');
    const insert = db.prepare('INSERT INTO items (flow, seq) VALUES (?, ?)');
    const countByFlow = db.prepare('SELECT COUNT(*) AS c FROM items WHERE flow = ?');

    const flows = 8;
    const perFlow = 25;
    async function writeFlow(name: string): Promise<void> {
      for (let seq = 0; seq < perFlow; seq++) {
        insert.run(name, seq);
        await Promise.resolve();
      }
    }

    await Promise.all(Array.from({ length: flows }, (_, index) => writeFlow(`f${index}`)));

    for (let index = 0; index < flows; index++) {
      const { c } = countByFlow.get(`f${index}`) as { c: number };
      expect(c).toBe(perFlow);
    }
    db.close();
  });

  test('cache evicts the oldest statement once capacity is reached', () => {
    const db = new Database(':memory:');
    const first = db.prepare('SELECT 0 AS v');
    const recent = Array.from({ length: STATEMENT_CACHE_CAPACITY }, (_, index) =>
      db.prepare(`SELECT ${index + 1} AS v`)
    );
    expect(db.prepare('SELECT 0 AS v')).not.toBe(first);
    expect(db.prepare(`SELECT ${STATEMENT_CACHE_CAPACITY} AS v`)).toBe(
      recent[STATEMENT_CACHE_CAPACITY - 1]
    );
    db.close();
  });
});

const nodeOnlyDescribe = typeof Bun === 'undefined' ? describe : describe.skip;

nodeOnlyDescribe('node:sqlite prepare options bypass the cache', () => {
  test('options produce a fresh statement on every call', async () => {
    const { Database: NodeDatabase } = await import('../../../../src/storage/sqlite-node');
    const db = new NodeDatabase(':memory:');
    const first = db.prepare('SELECT 1 AS x', { allowBareNamedParameters: true });
    const second = db.prepare('SELECT 1 AS x', { allowBareNamedParameters: true });
    expect(second).not.toBe(first);
    db.close();
  });
});
