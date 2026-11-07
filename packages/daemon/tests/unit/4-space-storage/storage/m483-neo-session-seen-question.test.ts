import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { runMigration340 } from '../../../../src/storage/schema/m340-neo-session-seen.ts';
import { runMigration483 } from '../../../../src/storage/schema/m483-neo-session-seen-question.ts';

describe('m483 neo_session_seen question', () => {
  test('adds the column once and keeps existing rows', () => {
    const db = new Database(':memory:');
    runMigration340(db as never);
    db.exec("INSERT INTO neo_session_seen(session_key, listed, status) VALUES ('k', 'l', 'done')");
    runMigration483(db as never);
    runMigration483(db as never);
    expect(db.prepare('SELECT status, question FROM neo_session_seen').get()).toEqual({
      status: 'done',
      question: null,
    });
    db.close();
  });
});
