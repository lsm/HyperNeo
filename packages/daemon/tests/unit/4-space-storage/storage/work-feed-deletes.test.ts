import { describe, expect, test } from 'bun:test';
import {
  createFeedTurnIndex,
  createWorkFeedOffsetsTable,
} from '../../../../src/storage/schema/m302-work-index-kinds';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { dropWorkFeedSession, purgeWorkFeedSessions } from '../../../../src/storage/work-feed';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import {
  seedWorkFeedDeleteCorpus,
  storedWorkFeedDigest,
} from '../../../helpers/work-feed-delete-corpus';

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
  test('large derived transcript cleanup runs as separate writer batches and keeps stored tool results intact', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    seedWorkFeedDeleteCorpus(db, 2000);
    const original = storedWorkFeedDigest(db);
    const count = () =>
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM message_search_content WHERE kind = 'claude'")
          .get() as { n: number }
      ).n;
    const samples: number[] = [];
    const inline = new DbGateway(':memory:', db);
    const gateway = {
      run: (...args: Parameters<DbGateway['run']>) => {
        samples.push(count());
        return inline.run(...args);
      },
    } as unknown as DbGateway;
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 0);
    try {
      await purgeWorkFeedSessions(
        gateway,
        'claude',
        Array.from({ length: 100 }, (_, i) => `sdk-${i}`)
      );
      expect(samples.some((left) => left > 0 && left < 2000)).toBe(true);
      expect(ticks).toBeGreaterThan(0);
      expect(count()).toBe(0);
      expect(storedWorkFeedDigest(db)).toBe(original);
      expect(
        db
          .prepare(
            "SELECT rowid FROM message_search_fts WHERE message_search_fts MATCH 'synthetic0token0'"
          )
          .all()
      ).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM message_search_fts WHERE message_search_fts MATCH 'codex'"
          )
          .get()
      ).toEqual({ n: 200 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM message_search_vectors').get()).toEqual({
        n: 0,
      });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM message_search_content WHERE kind = 'codex'").get()
      ).toEqual({ n: 200 });
    } finally {
      clearInterval(timer);
      db.close();
    }
  }, 30000);
  test('deletes only that kind for those sessions through the session index', async () => {
    const { db, plans, left } = setup();
    await purgeWorkFeedSessions(new DbGateway(':memory:', db), 'codex', ['s1']);
    expect(left()).toEqual(['c2', 'k1', 'm1']);
    expect(plans.some((plan) => plan.includes('idx_message_search_content_feed_turns'))).toBe(true);
    db.close();
  });
});

describe('dropWorkFeedSession', () => {
  test('deletes one session of one kind through the session index', async () => {
    const { db, plans, left } = setup();
    expect(await dropWorkFeedSession(db, 'claude', 's1', '/p')).toBe(1);
    expect(left()).toEqual(['c1', 'c2', 'm1']);
    expect(plans.some((plan) => plan.includes('idx_message_search_content_feed_turns'))).toBe(true);
    db.close();
  });
});
