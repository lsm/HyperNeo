import { expect, test } from 'bun:test';
import { runMigration477 } from '../../../../../src/storage/schema/m477-work-turns.ts';
import { runMigration480 } from '../../../../../src/storage/schema/m480-work-turn-urls.ts';
import { runMigrations } from '../../../../../src/storage/schema/migrations.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

test('migration 480 clears recorded turns so readers record final URLs from the start', () => {
  const db = new Database(':memory:');
  runMigration477(db);
  db.prepare(
    `INSERT INTO work_turns (ref, id, started_at, ended_at, ended, inputs, urls, complete, cursor)
     VALUES ('{"adapter":"hyperneo","id":"s"}', 't', 1, 2, 'success', '[]', '[]', 1, '{}')`
  ).run();
  runMigration480(db);
  runMigration480(db);
  expect(db.prepare('SELECT count(*) AS n FROM work_turns').get()).toEqual({ n: 0 });
  const columns = db.prepare('PRAGMA table_info(work_turns)').all() as { name: string }[];
  expect(columns.map(({ name }) => name)).toContain('final_urls');
  expect(db.prepare('SELECT count(*) AS n FROM work_turn_urls').get()).toEqual({ n: 0 });
  db.close();
});

test('a database marked 479 by either migration ends with both changes', () => {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(({ name }) => name);
  expect(columns('work_turns')).toContain('final_urls');
  expect(columns('work_sessions')).toContain('last_activity_at');
  db.exec(`ALTER TABLE work_sessions DROP COLUMN last_activity_at;
    DELETE FROM migration_markers WHERE key = 'migration_480'`);
  runMigrations(db, () => {});
  expect(columns('work_sessions')).toContain('last_activity_at');
  db.close();
});
