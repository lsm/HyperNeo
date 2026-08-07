import { describe, test, expect, beforeEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { ShortIdAllocator } from '../../../../src/lib/short-id-allocator.ts';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.run(`
		CREATE TABLE short_id_counters (
			entity_type TEXT NOT NULL,
			scope_id    TEXT NOT NULL,
			counter     INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (entity_type, scope_id)
		)
	`);
  return db;
}

describe('ShortIdAllocator', () => {
  let db: BunDatabase;
  let allocator: ShortIdAllocator;

  beforeEach(() => {
    db = makeDb();
    allocator = new ShortIdAllocator(db);
  });

  test('first allocation returns t-1 for task', () => {
    expect(allocator.allocate('task', 'room-1')).toBe('t-1');
  });

  test('second allocation returns t-2 for same scope', () => {
    allocator.allocate('task', 'room-1');
    expect(allocator.allocate('task', 'room-1')).toBe('t-2');
  });

  test('sequential allocations increment monotonically', () => {
    const results = [
      allocator.allocate('task', 'room-1'),
      allocator.allocate('task', 'room-1'),
      allocator.allocate('task', 'room-1'),
    ];
    expect(results).toEqual(['t-1', 't-2', 't-3']);
  });

  test('first goal allocation returns g-1', () => {
    expect(allocator.allocate('goal', 'room-1')).toBe('g-1');
  });

  test('task and goal counters are independent within same scope', () => {
    expect(allocator.allocate('task', 'room-1')).toBe('t-1');
    expect(allocator.allocate('goal', 'room-1')).toBe('g-1');
    expect(allocator.allocate('task', 'room-1')).toBe('t-2');
    expect(allocator.allocate('goal', 'room-1')).toBe('g-2');
  });

  test('different scopes are independent — both start at 1', () => {
    expect(allocator.allocate('task', 'room-A')).toBe('t-1');
    expect(allocator.allocate('task', 'room-B')).toBe('t-1');
    expect(allocator.allocate('task', 'room-A')).toBe('t-2');
    expect(allocator.allocate('task', 'room-B')).toBe('t-2');
  });

  test('rapid sequential allocations produce unique IDs', () => {
    const results = Array.from({ length: 50 }, () => allocator.allocate('task', 'room-concurrent'));
    const unique = new Set(results);
    expect(unique.size).toBe(50);
  });

  describe('getCounter', () => {
    test('returns 0 when no allocations have been made', () => {
      expect(allocator.getCounter('task', 'room-x')).toBe(0);
    });

    test('returns current counter after allocations', () => {
      allocator.allocate('task', 'room-1');
      allocator.allocate('task', 'room-1');
      allocator.allocate('task', 'room-1');
      expect(allocator.getCounter('task', 'room-1')).toBe(3);
    });

    test('getCounter does not increment the counter', () => {
      allocator.allocate('task', 'room-1');
      allocator.getCounter('task', 'room-1');
      allocator.getCounter('task', 'room-1');
      expect(allocator.getCounter('task', 'room-1')).toBe(1);
      expect(allocator.allocate('task', 'room-1')).toBe('t-2');
    });
  });
});
