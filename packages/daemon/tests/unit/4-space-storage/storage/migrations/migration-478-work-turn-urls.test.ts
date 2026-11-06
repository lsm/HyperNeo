import { expect, test } from 'bun:test';
import { runMigration477 } from '../../../../../src/storage/schema/m477-work-turns.ts';
import { runMigration478 } from '../../../../../src/storage/schema/m478-work-turn-urls.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

test('migration 478 clears recorded turns so readers record final URLs from the start', () => {
  const db = new Database(':memory:');
  runMigration477(db);
  db.prepare(
    `INSERT INTO work_turns (ref, id, started_at, ended_at, ended, inputs, urls, complete, cursor)
     VALUES ('{"adapter":"hyperneo","id":"s"}', 't', 1, 2, 'success', '[]', '[]', 1, '{}')`
  ).run();
  runMigration478(db);
  runMigration478(db);
  expect(db.prepare('SELECT count(*) AS n FROM work_turns').get()).toEqual({ n: 0 });
  const columns = db.prepare('PRAGMA table_info(work_turns)').all() as { name: string }[];
  expect(columns.map(({ name }) => name)).toContain('final_urls');
  expect(db.prepare('SELECT count(*) AS n FROM work_turn_urls').get()).toEqual({ n: 0 });
  db.close();
});
