import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration472 } from '../../../../../src/storage/schema/m472-drop-room-era-tables.ts';

const DEAD_TABLES = [
  'goals',
  'mission_executions',
  'mission_metric_history',
  'room_github_mappings',
  'room_mcp_enablement',
  'room_skill_overrides',
  'rooms',
  'tasks',
];

function remaining(db: Database): string[] {
  const names = DEAD_TABLES.map((name) => `'${name}'`).join(',');
  return (
    db
      .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${names})`)
      .all() as { name: string }[]
  )
    .map(({ name }) => name)
    .sort();
}

function insertRoom(db: Database): void {
  db.exec(`INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room', 'Room', 1, 1)`);
}

function insertGoal(db: Database): void {
  db.exec(
    `INSERT INTO goals (id, room_id, title, created_at, updated_at) VALUES ('goal', 'room', 'Goal', 1, 1)`
  );
}

function insertInboxItem(db: Database, id: string, roomId: string | null): void {
  db.prepare(
    `INSERT INTO inbox_items
       (id, source, repository, issue_number, title, body, author, routed_to_room_id,
        security_check, raw_event, received_at, updated_at)
     VALUES (?, 'github_issue', 'owner/repo', 7, 'Title', 'Body', 'author', ?, '{}', '{}', 1, 1)`
  ).run(id, roomId);
}

describe('migration 472: drop room-era tables', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(
      readFileSync(new URL('./fixtures/schema-baseline/v0.41.0.sql', import.meta.url), 'utf8')
    );
  });

  afterEach(() => {
    db.close();
  });

  test('drops every empty table with its indexes', () => {
    runMigration472(db);

    expect(remaining(db)).toEqual([]);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_schema WHERE type = 'index'
           AND (name LIKE 'idx_tasks_%' OR name LIKE 'idx_goals_%' OR name LIKE 'idx_mission_%'
             OR name LIKE 'idx_room_github_%')`
        )
        .all()
    ).toEqual([]);
  });

  test('keeps inbox rows and accepts new ones after rooms is gone', () => {
    insertInboxItem(db, 'unrouted', null);
    db.exec('PRAGMA foreign_keys = OFF');
    insertInboxItem(db, 'routed', 'old-room');
    db.exec('PRAGMA foreign_keys = ON');

    runMigration472(db);

    insertInboxItem(db, 'new', 'room-that-no-longer-exists');
    expect(remaining(db)).toEqual([]);
    expect(db.prepare(`SELECT id, routed_to_room_id FROM inbox_items ORDER BY id`).all()).toEqual([
      { id: 'new', routed_to_room_id: 'room-that-no-longer-exists' },
      { id: 'routed', routed_to_room_id: 'old-room' },
      { id: 'unrouted', routed_to_room_id: null },
    ]);
    expect(db.prepare(`SELECT * FROM pragma_foreign_key_list('inbox_items')`).all()).toEqual([]);
    expect(
      (
        db
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'inbox_items'`
          )
          .all() as { name: string }[]
      )
        .map(({ name }) => name)
        .filter((name) => name.startsWith('idx_'))
        .sort()
    ).toEqual(['idx_inbox_items_repository', 'idx_inbox_items_status']);
  });

  test('keeps a table with rows and the parents it references', () => {
    insertRoom(db);
    insertGoal(db);
    db.exec(
      `INSERT INTO mission_metric_history (id, goal_id, metric_name, value, recorded_at)
       VALUES ('metric', 'goal', 'count', 1, 1)`
    );

    runMigration472(db);

    expect(remaining(db)).toEqual(['goals', 'mission_metric_history', 'rooms']);
    expect(db.prepare(`SELECT id FROM mission_metric_history`).all()).toEqual([{ id: 'metric' }]);
    expect(db.prepare(`SELECT id FROM goals`).all()).toEqual([{ id: 'goal' }]);
  });

  test('keeps rooms alone when only rooms has rows', () => {
    insertRoom(db);

    runMigration472(db);

    expect(remaining(db)).toEqual(['rooms']);
  });

  test('keeps a parent while an orphaned child row survives', () => {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(
      `INSERT INTO tasks (id, room_id, title, description, created_at)
       VALUES ('task', 'missing-room', 'Task', 'Description', 1)`
    );
    db.exec('PRAGMA foreign_keys = ON');

    runMigration472(db);

    expect(remaining(db)).toEqual(['rooms', 'tasks']);
  });

  test('a second run changes nothing', () => {
    runMigration472(db);
    const schema = db.prepare(`SELECT name, sql FROM sqlite_schema ORDER BY name`).all();

    runMigration472(db);

    expect(db.prepare(`SELECT name, sql FROM sqlite_schema ORDER BY name`).all()).toEqual(schema);
  });
});
