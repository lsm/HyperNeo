import { describe, expect, test } from 'bun:test';
import { runMigration406 } from '../../../../src/storage/schema/m406-goal-owner-session.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const snapshot = (db: Database, table: string) =>
  db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all();
const schema = (db: Database) =>
  db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
function legacy() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec('PRAGMA foreign_keys=OFF');
  runMigration406(db);
  for (const table of ['neo_asks', 'goal_journal']) {
    const { sql } = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table) as {
      sql: string;
    };
    const objects = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE tbl_name=? AND type='index' AND sql IS NOT NULL"
      )
      .all(table) as { sql: string }[];
    db.exec(
      sql
        .replace(table, `${table}_old`)
        .replaceAll('REFERENCES neo_goals', 'REFERENCES space_goals')
    );
    db.exec(`DROP TABLE ${table}; ALTER TABLE ${table}_old RENAME TO ${table}`);
    for (const object of objects) db.exec(object.sql);
  }
  db.exec(
    "DROP TABLE IF EXISTS neo_goals; DELETE FROM migration_markers WHERE key='migration_444'; PRAGMA foreign_keys=ON"
  );
  return db;
}
const migrate = (db: Database) => runMigrations(db, () => {});

describe('standalone goal upgrade', () => {
  test('preserves 266 asks, parent and child rows, rowids, indexes and triggers', () => {
    const db = legacy();
    try {
      const insert = db.prepare(
        "INSERT INTO neo_asks(id,parent_id,session_id,title,request,created_at,updated_at) VALUES(?,?,'neo:root',?,'Keep original text',1,1)"
      );
      for (let i = 0; i < 266; i++) insert.run(`ask-${i}`, i ? 'ask-0' : null, `Ask ${i}`);
      db.exec(`INSERT INTO neo_todos(id,ask_id,position,title,done_when,created_at,updated_at) VALUES('todo','ask-265',0,'Keep child','Retained',1,1);
        INSERT INTO neo_questions(id,ask_id,text,kind,created_at) VALUES('question','ask-265','Retain?','yesno',1);
        CREATE TABLE trigger_observations(id TEXT);
        CREATE TRIGGER ask_observation AFTER UPDATE ON neo_asks BEGIN INSERT INTO trigger_observations VALUES(new.id); END`);
      const tables = ['neo_asks', 'neo_todos', 'neo_questions'];
      const before = tables.map((table) => snapshot(db, table));
      const objects = db
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE tbl_name='neo_asks' AND type IN ('index','trigger') ORDER BY name"
        )
        .all();
      migrate(db);
      expect(tables.map((table) => snapshot(db, table))).toEqual(before);
      expect(
        db
          .prepare(
            "SELECT name,sql FROM sqlite_master WHERE tbl_name='neo_asks' AND type IN ('index','trigger') ORDER BY name"
          )
          .all()
      ).toEqual(objects);
      expect(db.prepare('PRAGMA foreign_key_list(neo_asks)').all()).toContainEqual(
        expect.objectContaining({ from: 'goal_id', table: 'neo_goals' })
      );
      db.exec("UPDATE neo_asks SET title='Human edit' WHERE id='ask-265'");
      expect(db.prepare('SELECT * FROM trigger_observations').all()).toEqual([{ id: 'ask-265' }]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      migrate(db);
      expect(db.prepare('SELECT COUNT(*) AS n FROM neo_asks').get()).toEqual({ n: 266 });
    } finally {
      db.close();
    }
  });
  test('keeps genuine Space goals, their event and legacy Rooms goal bytes', () => {
    const db = legacy();
    try {
      db.exec(`INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at) VALUES('space','space','/synthetic','Space',1,1);
        INSERT INTO space_goals(id,space_id,title,created_at,updated_at) VALUES('space-goal','space','Space goal',1,1);
        INSERT INTO space_goal_events(id,space_id,goal_id,event_type,source,created_at) VALUES('event','space','space-goal','created','rpc',1);
        INSERT INTO rooms(id,name,created_at,updated_at) VALUES('room','Legacy room',1,1);
        INSERT INTO goals(id,room_id,title,created_at,updated_at) VALUES('legacy','room','Legacy goal',1,1)`);
      const tables = ['space_goals', 'space_goal_events', 'goals'];
      const before = tables.map((table) => snapshot(db, table));
      migrate(db);
      expect(tables.map((table) => snapshot(db, table))).toEqual(before);
      expect(() =>
        db.exec(
          "INSERT INTO space_goals(id,title,created_at,updated_at) VALUES('unowned','No space',1,1)"
        )
      ).toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
  test('refuses a session goal without changing rows or schema or marking success', () => {
    const db = legacy();
    try {
      db.exec(
        "INSERT INTO space_goals(id,owner_session_id,title,created_at,updated_at) VALUES('unexpected','neo:root','Human started it',1,1)"
      );
      const before = schema(db),
        rows = snapshot(db, 'space_goals');
      expect(() => migrate(db)).toThrow('m444_legacy_session_goals');
      expect(snapshot(db, 'space_goals')).toEqual(rows);
      expect(schema(db)).toEqual(before);
      expect(
        db.prepare("SELECT 1 FROM migration_markers WHERE key='migration_444'").get()
      ).toBeNull();
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
    }
  });
  test('refuses a journal rather than losing entries or changing their foreign key', () => {
    const db = legacy();
    try {
      db.exec(
        "PRAGMA foreign_keys=OFF; INSERT INTO goal_journal(id,goal_id,done,effect,worked,created_at) VALUES('journal','missing','Human work','Retain','Examples',1); PRAGMA foreign_keys=ON"
      );
      const rows = snapshot(db, 'goal_journal');
      expect(() => migrate(db)).toThrow('m444_legacy_goal_journal');
      expect(snapshot(db, 'goal_journal')).toEqual(rows);
      expect(db.prepare('PRAGMA foreign_key_list(goal_journal)').all()).toContainEqual(
        expect.objectContaining({ table: 'space_goals' })
      );
    } finally {
      db.close();
    }
  });
  test('dangling ask goal refuses atomic rebuild instead of clearing the link', () => {
    const db = legacy();
    try {
      db.exec(
        "PRAGMA foreign_keys=OFF; INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at,goal_id) VALUES('ask','neo:root','Retain','Retain',1,1,'missing'); PRAGMA foreign_keys=ON"
      );
      const before = schema(db);
      expect(() => migrate(db)).toThrow('m444_foreign_key_violation');
      expect(db.prepare('SELECT goal_id FROM neo_asks').get()).toEqual({ goal_id: 'missing' });
      expect(schema(db)).toEqual(before);
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
    }
  });
});
