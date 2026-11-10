import { describe, expect, test } from 'bun:test';
import {
  syntheticTodoDb,
  todoPlan,
  todoQueries,
} from '../../../../../../.claude/skills/verify/todo-query-plans.ts';
import { runMigration456 } from '../../../../src/storage/schema/m456-neo-todo-query-indexes.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('Neo todo query plans at observed row counts', () => {
  test('fresh table creation works before the Neo tables exist', () => {
    const db = new Database(':memory:');
    try {
      createTables(db);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get()).toEqual({
        name: 'sessions',
      });
      runMigrations(db, () => {});
      createTables(db);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_neo_todo_sessions_ref'").get()
      ).toEqual({ name: 'idx_neo_todo_sessions_ref' });
    } finally {
      db.close();
    }
  });

  test('the marker sequence records the index upgrade on an existing database', () => {
    const db = syntheticTodoDb();
    try {
      db.exec("DELETE FROM migration_markers WHERE key = 'migration_456'");
      runMigrations(db, () => {});
      expect(
        db.prepare("SELECT key FROM migration_markers WHERE key = 'migration_456'").get()
      ).toEqual({ key: 'migration_456' });
    } finally {
      db.close();
    }
  });

  test('recovery locates doing todos without a full todo scan', () => {
    const db = syntheticTodoDb();
    try {
      const plan = todoPlan(db, todoQueries.recovery, []);
      expect(plan.some((detail) => /^SCAN t\b/.test(detail))).toBe(false);
    } finally {
      db.close();
    }
  });

  test('per-ask ordering does not need a temporary sort', () => {
    const db = syntheticTodoDb();
    try {
      expect(
        todoPlan(db, todoQueries.list, ['a0']).some((detail) => detail.includes('TEMP B-TREE'))
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  test('the index migration can upgrade and restart without changing rows', () => {
    const db = syntheticTodoDb();
    try {
      const before = db.prepare('SELECT * FROM neo_todo_sessions ORDER BY todo_id').all();
      db.exec(
        'DROP INDEX idx_neo_todo_sessions_ref; DROP INDEX idx_neo_todos_state_ask; DROP INDEX idx_neo_todos_ask_order'
      );
      runMigration456(db);
      runMigration456(db);
      expect(db.prepare('SELECT * FROM neo_todo_sessions ORDER BY todo_id').all()).toEqual(before);
      expect(
        todoPlan(db, todoQueries.recovery, []).some((detail) => /^SCAN t\b/.test(detail))
      ).toBe(false);
    } finally {
      db.close();
    }
  });
});
