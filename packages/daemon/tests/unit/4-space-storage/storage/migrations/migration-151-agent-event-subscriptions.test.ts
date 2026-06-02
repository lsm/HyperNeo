import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration151 } from '../../../../../src/storage/schema/migrations';

describe('Migration 151: consolidate agent event subscriptions', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE space_agents (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL
      );
      CREATE TABLE space_long_horizon_agents (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL
      );
      CREATE TABLE space_agent_event_subscriptions (
        space_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        topic_pattern TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, topic_pattern)
      );
      CREATE TABLE space_long_horizon_agent_event_subscriptions (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source TEXT NOT NULL,
        topic TEXT NOT NULL,
        filter_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(space_id, agent_id, source, topic, filter_json)
      );
    `);
    db.prepare(`INSERT INTO spaces (id) VALUES (?)`).run('space-1');
    db.prepare(`INSERT INTO space_agents (id, space_id) VALUES (?, ?)`).run(
      'lh-agent-1',
      'space-1'
    );
    db.prepare(`INSERT INTO space_agents (id, space_id) VALUES (?, ?)`).run(
      'legacy-agent-1',
      'space-1'
    );
    db.prepare(`INSERT INTO space_long_horizon_agents (id, space_id) VALUES (?, ?)`).run(
      'lh-agent-1',
      'space-1'
    );
  });

  afterEach(() => {
    db.close();
  });

  test('copies legacy rows for long-horizon agent ids and drops legacy table', () => {
    db.prepare(
      `INSERT INTO space_agent_event_subscriptions (space_id, agent_id, topic_pattern, label, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      'space-1',
      'lh-agent-1',
      'github/lsm/neokai/pull_request/*.review_submitted',
      'reviews',
      123
    );
    db.prepare(
      `INSERT INTO space_agent_event_subscriptions (space_id, agent_id, topic_pattern, label, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('space-1', 'legacy-agent-1', 'github/lsm/neokai/issues/*.opened', null, 123);

    runMigration151(db);

    expect(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('space_agent_event_subscriptions')
    ).toBeNull();
    expect(
      db
        .prepare(
          `SELECT agent_id, source, topic, filter_json, status, created_at FROM space_long_horizon_agent_event_subscriptions`
        )
        .all()
    ).toEqual([
      {
        agent_id: 'lh-agent-1',
        source: 'github',
        topic: 'github/lsm/neokai/pull_request/*.review_submitted',
        filter_json: '{"label":"reviews"}',
        status: 'active',
        created_at: 123,
      },
    ]);
  });

  test('is a no-op when legacy table is absent', () => {
    db.exec(`DROP TABLE space_agent_event_subscriptions`);

    expect(() => runMigration151(db)).not.toThrow();
  });
});
