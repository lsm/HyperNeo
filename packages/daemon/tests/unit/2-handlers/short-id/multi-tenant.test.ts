import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { ShortIdAllocator } from '../../../../src/lib/short-id-allocator';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
		CREATE TABLE short_id_counters (
			entity_type TEXT NOT NULL,
			scope_id    TEXT NOT NULL,
			counter     INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (entity_type, scope_id)
		);
	`);
  return db;
}

describe('Multi-tenant short ID isolation', () => {
  let db: Database;
  let allocator: ShortIdAllocator;

  const ROOM_A = 'room-a-uuid-0001';
  const ROOM_B = 'room-b-uuid-0002';

  beforeEach(() => {
    db = makeDb();
    allocator = new ShortIdAllocator(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('goal short IDs are scoped per room', () => {
    it('Room A and Room B both have g-1 independently', () => {
      const gA1 = allocator.allocate('goal', ROOM_A);
      const gB1 = allocator.allocate('goal', ROOM_B);

      expect(gA1).toBe('g-1');
      expect(gB1).toBe('g-1');
    });

    it('Room A and Room B goal counters are fully independent', () => {
      const gA1 = allocator.allocate('goal', ROOM_A);
      const gA2 = allocator.allocate('goal', ROOM_A);

      const gB1 = allocator.allocate('goal', ROOM_B);

      expect(gA1).toBe('g-1');
      expect(gA2).toBe('g-2');
      expect(gB1).toBe('g-1');
    });
  });

  describe('task and goal counters are independent within the same room', () => {
    it('task counter and goal counter do not interfere in the same room', () => {
      const t1 = allocator.allocate('task', ROOM_A);
      const g1 = allocator.allocate('goal', ROOM_A);

      expect(t1).toBe('t-1');
      expect(g1).toBe('g-1');

      const t2 = allocator.allocate('task', ROOM_A);
      const g2 = allocator.allocate('goal', ROOM_A);

      expect(t2).toBe('t-2');
      expect(g2).toBe('g-2');
    });
  });

  describe('short_id_counters table isolation', () => {
    it('each (entity_type, scope_id) pair gets its own counter row', () => {
      allocator.allocate('task', ROOM_A);
      allocator.allocate('task', ROOM_A);
      allocator.allocate('task', ROOM_A);

      allocator.allocate('task', ROOM_B);
      allocator.allocate('task', ROOM_B);

      allocator.allocate('goal', ROOM_A);
      allocator.allocate('goal', ROOM_B);

      const rows = db
        .prepare(
          `SELECT entity_type, scope_id, counter
					 FROM short_id_counters
					 ORDER BY entity_type, scope_id`
        )
        .all() as { entity_type: string; scope_id: string; counter: number }[];

      expect(rows.length).toBe(4);

      const taskRoomA = rows.find((r) => r.entity_type === 'task' && r.scope_id === ROOM_A);
      const taskRoomB = rows.find((r) => r.entity_type === 'task' && r.scope_id === ROOM_B);
      const goalRoomA = rows.find((r) => r.entity_type === 'goal' && r.scope_id === ROOM_A);
      const goalRoomB = rows.find((r) => r.entity_type === 'goal' && r.scope_id === ROOM_B);

      expect(taskRoomA).toBeDefined();
      expect(taskRoomA!.counter).toBe(3);

      expect(taskRoomB).toBeDefined();
      expect(taskRoomB!.counter).toBe(2);

      expect(goalRoomA).toBeDefined();
      expect(goalRoomA!.counter).toBe(1);

      expect(goalRoomB).toBeDefined();
      expect(goalRoomB!.counter).toBe(1);
    });

    it('counter rows have the correct primary key — no cross-room bleed possible', () => {
      allocator.allocate('task', ROOM_A);
      allocator.allocate('task', ROOM_B);

      expect(() => {
        db.prepare(
          `INSERT INTO short_id_counters (entity_type, scope_id, counter)
					 VALUES ('task', ?, 99)`
        ).run(ROOM_A);
      }).toThrow();
    });

    it('getCounter reflects per-room state accurately', () => {
      allocator.allocate('task', ROOM_A);
      allocator.allocate('task', ROOM_A);
      allocator.allocate('task', ROOM_B);

      expect(allocator.getCounter('task', ROOM_A)).toBe(2);
      expect(allocator.getCounter('task', ROOM_B)).toBe(1);
      expect(allocator.getCounter('task', 'room-c-uuid-0003')).toBe(0);
    });
  });
});
