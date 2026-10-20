import { describe, expect, test } from 'bun:test';
import {
  createFeedTurnIndex,
  createWorkFeedOffsetsTable,
} from '../../../../src/storage/schema/m302-work-index-kinds';
import { Database } from '../../../../src/storage/sqlite-compat';
import { dropWorkFeedSession, purgeWorkFeedSessions } from '../../../../src/storage/work-feed';

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE message_search_content (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT,
    session_id TEXT, timestamp INTEGER, UNIQUE (kind, source_id))`);
  createWorkFeedOffsetsTable(db);
  createFeedTurnIndex(db);
  const insert = db.prepare(
    'INSERT INTO message_search_content (kind, source_id, session_id, timestamp) VALUES (?, ?, ?, 1)'
  );
  for (const [kind, source, session] of [
    ['codex', 'c1', 's1'],
    ['codex', 'c2', 's2'],
    ['claude', 'k1', 's1'],
    ['message', 'm1', 's1'],
  ])
    insert.run(kind, source, session);
  const plans: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    if (sql.trim().startsWith('DELETE FROM message_search_content'))
      plans.push(
        ...(prepare(`EXPLAIN QUERY PLAN ${sql}`).all('codex', '[]') as { detail: string }[]).map(
          (row) => row.detail
        )
      );
    return prepare(sql);
  }) as typeof db.prepare;
  const left = () =>
    (
      prepare('SELECT source_id FROM message_search_content ORDER BY source_id').all() as {
        source_id: string;
      }[]
    ).map((row) => row.source_id);
  return { db, plans, left };
}

describe('purgeWorkFeedSessions', () => {
  test('deletes only that kind for those sessions through the session index', () => {
    const { db, plans, left } = setup();
    purgeWorkFeedSessions(db, 'codex', ['s1']);
    expect(left()).toEqual(['c2', 'k1', 'm1']);
    expect(plans.some((plan) => plan.includes('idx_message_search_content_feed_turns'))).toBe(true);
    db.close();
  });
});

describe('dropWorkFeedSession', () => {
  test('deletes one session of one kind through the session index', () => {
    const { db, plans, left } = setup();
    expect(dropWorkFeedSession(db, 'claude', 's1', '/p')).toBe(1);
    expect(left()).toEqual(['c1', 'c2', 'm1']);
    expect(plans.some((plan) => plan.includes('idx_message_search_content_feed_turns'))).toBe(true);
    db.close();
  });
});
