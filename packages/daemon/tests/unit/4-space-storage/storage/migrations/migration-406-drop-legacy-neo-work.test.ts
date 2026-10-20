import { describe, expect, test } from 'bun:test';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration406 } from '../../../../../src/storage/schema/m406-drop-legacy-neo-work.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const tables = (db: Database) =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

describe('runMigration406', () => {
  test('drops the legacy card and ask tables with their rows and keeps the new ask tables', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`CREATE TABLE neo_work (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE legacy_neo_asks (id TEXT PRIMARY KEY);
      CREATE TABLE neo_ask_items (ask_id TEXT REFERENCES legacy_neo_asks(id), delivered_by TEXT REFERENCES neo_work(id));
      CREATE TABLE neo_work_driver_targets (work_id TEXT PRIMARY KEY REFERENCES neo_work(id));
      CREATE TABLE neo_agent_work_targets (work_id TEXT PRIMARY KEY REFERENCES neo_work(id));
      CREATE TABLE neo_asks (id TEXT PRIMARY KEY);
      CREATE TABLE neo_todos (id TEXT PRIMARY KEY);
      INSERT INTO neo_work VALUES ('w1', 'reported');
      INSERT INTO legacy_neo_asks VALUES ('a1');
      INSERT INTO neo_ask_items VALUES ('a1', 'w1');
      INSERT INTO neo_work_driver_targets VALUES ('w1');
      INSERT INTO neo_agent_work_targets VALUES ('w1');
      INSERT INTO neo_asks VALUES ('live');`);
    runMigration406(db);
    runMigration406(db);
    expect(tables(db)).toEqual(['neo_asks', 'neo_todos']);
    expect(db.prepare('SELECT id FROM neo_asks').all()).toEqual([{ id: 'live' }]);
  });

  test('a restart does not bring any legacy table back', () => {
    const db = new Database(':memory:');
    const legacy = () =>
      tables(db).filter(
        (name) =>
          name.startsWith('neo_work') ||
          ['legacy_neo_asks', 'neo_ask_items', 'neo_ask_work', 'neo_ask_checks'].includes(name) ||
          name === 'neo_agent_work_targets'
      );
    createTables(db);
    runMigrations(db, () => {});
    expect(legacy()).toEqual([]);
    createTables(db);
    runMigrations(db, () => {});
    expect(legacy()).toEqual([]);
  });
});
