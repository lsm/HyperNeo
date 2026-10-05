import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { readWorkTurns } from '../../../../src/storage/work-turns';

describe('readWorkTurns', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE message_search_content (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT,
      message_id TEXT, session_id TEXT, message_type TEXT, body TEXT, timestamp INTEGER)`);
    const insert = db.prepare(
      `INSERT INTO message_search_content (kind, source_id, message_id, session_id, message_type, body, timestamp)
       VALUES ('message', ?, ?, ?, ?, ?, ?)`
    );
    for (let n = 1; n <= 6; n++) {
      insert.run(`row${n}`, `m${n}`, 's1', n % 2 ? 'user' : 'assistant', `turn ${n}`, n * 10);
    }
    insert.run('row7', 'm7', 's2', 'user', 'other chat', 15);
    insert.run('row8', null, 's1', 'assistant', 'x'.repeat(5_000), 70);
  });
  afterEach(() => db.close());

  const ids = (turns: ReturnType<typeof readWorkTurns>) => turns?.map((turn) => turn.messageId);

  test('reads the turns around a message, oldest first, within the session', () => {
    expect(ids(readWorkTurns(db, 's1', 'm3', 1, 2))).toEqual(['m2', 'm3', 'm4', 'm5']);
    expect(readWorkTurns(db, 's1', 'm3', 0, 0)).toEqual([
      { messageId: 'm3', role: 'user', at: 30, text: 'turn 3' },
    ]);
  });

  test('reads the latest turns without an anchor and cuts long text', () => {
    const turns = readWorkTurns(db, 's1', undefined, 1, 0);
    expect(ids(turns)).toEqual(['m6', 'row8']);
    expect(turns?.[1].text).toBe(`${'x'.repeat(4_000)}…`);
  });

  test('returns null for an unknown message or an empty session', () => {
    expect(readWorkTurns(db, 's1', 'm7', 2, 2)).toBeNull();
    expect(readWorkTurns(db, 'nobody', undefined, 2, 2)).toBeNull();
  });
});
