import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration400 } from '../../../../../src/storage/schema/m400-drop-neo-consultations.ts';

const tables = [
  'neo_consultations',
  'neo_consultation_waiters',
  'neo_context_write_grants',
  'neo_consultation_publications',
  'neo_cross_project_dispatches',
  'neo_cross_project_dispatch_members',
];

describe('runMigration400', () => {
  test('drops dispatch history that references waiters with foreign keys on, then reruns', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE neo_consultations(id TEXT PRIMARY KEY);
        CREATE TABLE neo_consultation_waiters(id TEXT PRIMARY KEY);
        CREATE TABLE neo_context_write_grants(
          consultation_id TEXT PRIMARY KEY REFERENCES neo_consultations(id) ON DELETE CASCADE);
        CREATE TABLE neo_consultation_publications(
          consultation_id TEXT PRIMARY KEY REFERENCES neo_consultations(id) ON DELETE CASCADE);
        CREATE TABLE neo_cross_project_dispatches(id TEXT PRIMARY KEY);
        CREATE TABLE neo_cross_project_dispatch_members(
          group_id TEXT NOT NULL REFERENCES neo_cross_project_dispatches(id),
          receipt_id TEXT NOT NULL UNIQUE REFERENCES neo_consultation_waiters(id));
        INSERT INTO neo_consultations VALUES ('c');
        INSERT INTO neo_consultation_waiters VALUES ('w');
        INSERT INTO neo_context_write_grants VALUES ('c');
        INSERT INTO neo_consultation_publications VALUES ('c');
        INSERT INTO neo_cross_project_dispatches VALUES ('g');
        INSERT INTO neo_cross_project_dispatch_members VALUES ('g', 'w');`);
      runMigration400(db);
      runMigration400(db);
      const left = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(() => '?').join(', ')})`
        )
        .all(...tables);
      expect(left).toEqual([]);
    } finally {
      db.close();
    }
  });
});
