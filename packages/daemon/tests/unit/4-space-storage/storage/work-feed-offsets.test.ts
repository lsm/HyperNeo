import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { describe, expect, test } from 'bun:test';
import {
  createFeedTurnIndex,
  createWorkFeedOffsetsTable,
} from '../../../../src/storage/schema/m302-work-index-kinds';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  dropWorkFeedSession,
  purgeWorkFeedSessions,
  readWorkFeedOffsets,
  rereadWorkFeedPaths,
  saveWorkFeedChunk,
} from '../../../../src/storage/work-feed';

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE message_search_content (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT,
    message_id TEXT, session_id TEXT, task_id TEXT, space_id TEXT, task_number INTEGER,
    message_type TEXT, title TEXT, body TEXT, timestamp INTEGER, UNIQUE (kind, source_id))`);
  createWorkFeedOffsetsTable(db);
  createFeedTurnIndex(db);
  let reads = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    if (/^\s*SELECT .* FROM work_feed_offsets/.test(sql)) reads++;
    return prepare(sql);
  }) as typeof db.prepare;
  const table = () =>
    new Map(
      (
        prepare('SELECT path, offset, size, mtime FROM work_feed_offsets ORDER BY path').all() as {
          path: string;
          offset: number;
          size: number;
          mtime: number;
        }[]
      ).map(({ path, ...offset }) => [path, offset])
    );
  return { db, reads: () => reads, table };
}

const turn = (id: string, session: string) => ({
  sourceId: id,
  messageId: id,
  sessionId: session,
  role: 'user' as const,
  text: 'hello',
  at: 1,
});

describe('readWorkFeedOffsets', () => {
  test('reads the offsets table once, then answers repeated feed polls from memory', () => {
    const { db, reads } = setup();
    for (let i = 0; i < 35; i++) readWorkFeedOffsets(db);
    expect(reads()).toBe(1);
  });

  test('stays equal to the table after every writer, including drop and purge', async () => {
    const { db, table } = setup();
    expect(readWorkFeedOffsets(db)).toEqual(table());
    saveWorkFeedChunk(db, 'claude', 't', [turn('a', 's1')], '/a.jsonl', {
      offset: 10,
      size: 10,
      mtime: 1,
    });
    saveWorkFeedChunk(db, 'claude', 't', [turn('b', 's2')], '/b.jsonl', {
      offset: 5,
      size: 9,
      mtime: 2,
    });
    expect(readWorkFeedOffsets(db)).toEqual(table());
    saveWorkFeedChunk(db, 'claude', 't', [], '/a.jsonl', { offset: 20, size: 20, mtime: 3 });
    expect(readWorkFeedOffsets(db)).toEqual(table());
    rereadWorkFeedPaths(db, ['/b.jsonl', '/missing.jsonl']);
    expect(readWorkFeedOffsets(db)).toEqual(table());
    await dropWorkFeedSession(db, 'claude', 's1', '/a.jsonl');
    expect(readWorkFeedOffsets(db)).toEqual(table());
    await purgeWorkFeedSessions(new DbGateway(':memory:', db), 'claude', ['s2']);
    expect(readWorkFeedOffsets(db)).toEqual(table());
    expect([...table().keys()]).toEqual(['/b.jsonl']);
  });

  test('hands out a snapshot of frozen offsets, unchanged by later writes and impossible to mutate', () => {
    const { db } = setup();
    saveWorkFeedChunk(db, 'codex', 't', [], '/a.jsonl', { offset: 1, size: 1, mtime: 1 });
    const snapshot = readWorkFeedOffsets(db);
    saveWorkFeedChunk(db, 'codex', 't', [], '/a.jsonl', { offset: 2, size: 2, mtime: 2 });
    expect(snapshot.get('/a.jsonl')).toEqual({ offset: 1, size: 1, mtime: 1 });
    expect(() => {
      (snapshot.get('/a.jsonl') as { offset: number }).offset = 99;
    }).toThrow();
    expect(readWorkFeedOffsets(db).get('/a.jsonl')).toEqual({ offset: 2, size: 2, mtime: 2 });
  });
});
