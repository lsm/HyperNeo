import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { embedPendingTurns } from '../../../../src/lib/drivers/turn-embedding';
import { runMigration297 } from '../../../../src/storage/schema/m297-message-search-vectors';
import { Database } from '../../../../src/storage/sqlite-compat';
import { readPendingTurns } from '../../../../src/storage/turn-vectors';

describe('embedPendingTurns', () => {
  let db: Database;
  const embedded: string[] = [];
  const embedder = {
    model: 'test-model',
    dimensions: 3,
    embedQuery: (text: string) => [text.length, 0, 1],
    embedPassage: async (text: string) => {
      embedded.push(text);
      return [text.length, 1, 0];
    },
  };

  beforeEach(() => {
    embedded.length = 0;
    db = new Database(':memory:');
    db.exec(`CREATE TABLE message_search_content (id INTEGER PRIMARY KEY, kind TEXT, body TEXT)`);
    runMigration297(db);
    const insert = db.prepare(`INSERT INTO message_search_content (kind, body) VALUES (?, ?)`);
    insert.run('message', 'an older turn about the font size');
    insert.run('message', 'short');
    insert.run('task', 'a task record long enough to embed');
    insert.run('message', `the newest turn ${'y'.repeat(3_000)}`);
  });
  afterEach(() => db.close());

  test('embeds the newest pending turns once, skipping tasks and short text', async () => {
    expect(await embedPendingTurns(db, embedder)).toEqual({ embedded: 2 });
    expect(embedded.map((text) => text.slice(0, 16))).toEqual([
      'the newest turn ',
      'an older turn ab',
    ]);
    expect(embedded[0]).toHaveLength(2_000);
    expect(await embedPendingTurns(db, embedder)).toEqual({ embedded: 0 });
    const row = db
      .prepare(
        `SELECT model, dimensions, length(embedding) AS bytes FROM message_search_vectors WHERE content_id = 4`
      )
      .get();
    expect(row).toEqual({ model: 'test-model', dimensions: 3, bytes: 12 });
  });

  test('re-embeds turns from another model and drops vectors with their turn', async () => {
    await embedPendingTurns(db, embedder);
    expect(readPendingTurns(db, 'next-model', 3, 10).map((turn) => turn.id)).toEqual([4, 1]);
    db.exec(`DELETE FROM message_search_content WHERE id = 4`);
    expect(
      db.prepare(`SELECT content_id FROM message_search_vectors ORDER BY content_id`).all()
    ).toEqual([{ content_id: 1 }]);
  });
});
