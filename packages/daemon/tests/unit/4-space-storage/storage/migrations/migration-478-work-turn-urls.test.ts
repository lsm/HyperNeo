import { expect, test } from 'bun:test';
import { runMigration477 } from '../../../../../src/storage/schema/m477-work-turns.ts';
import { runMigration478 } from '../../../../../src/storage/schema/m478-work-turn-urls.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

test('migration 478 indexes the URLs of turns already recorded', () => {
  const db = new Database(':memory:');
  runMigration477(db);
  db.prepare(
    `INSERT INTO work_turns (ref, id, started_at, ended_at, ended, inputs, urls, complete, cursor)
     VALUES ('{"adapter":"hyperneo","id":"s"}', 't', 1, 2, 'success', '[]', ?, 1, '{}')`
  ).run(JSON.stringify(['https://github.com/Acme/App/pull/7']));
  runMigration478(db);
  runMigration478(db);
  expect(db.prepare('SELECT url, turn_id AS id FROM work_turn_urls').all()).toEqual([
    { url: 'https://github.com/acme/app/pull/7', id: 't' },
  ]);
  db.close();
});
