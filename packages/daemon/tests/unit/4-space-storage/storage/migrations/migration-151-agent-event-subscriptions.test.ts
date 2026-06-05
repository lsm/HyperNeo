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
        space_id TEXT NOT NULL,
        name TEXT,
        handle TEXT,
        instructions TEXT,
        system_prompt TEXT,
        custom_prompt TEXT,
        status TEXT,
        model TEXT,
        tools TEXT,
        provider TEXT,
        setting_sources TEXT,
        created_at INTEGER
      );
      CREATE TABLE space_long_horizon_agents (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        handle TEXT NOT NULL,
        display_name TEXT NOT NULL,
        template_key TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        session_id TEXT,
        instructions TEXT NOT NULL DEFAULT '',
        autonomy_level INTEGER,
        model TEXT,
        thinking_level TEXT,
        provider TEXT,
        setting_sources TEXT,
        tool_permissions_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_space_long_horizon_agents_handle
        ON space_long_horizon_agents(space_id, handle) WHERE status != 'archived';
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
    db.prepare(
      `INSERT INTO space_agents (id, space_id, name, handle, instructions, system_prompt, custom_prompt, status, model, tools, provider, setting_sources, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'lh-agent-1',
      'space-1',
      'Existing LH',
      'existing-lh',
      '',
      '',
      null,
      'active',
      null,
      '[]',
      null,
      null,
      100
    );
    db.prepare(
      `INSERT INTO space_agents (id, space_id, name, handle, instructions, system_prompt, custom_prompt, status, model, tools, provider, setting_sources, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'legacy-agent-1',
      'space-1',
      'Legacy Agent',
      'legacy-agent',
      'Legacy instructions',
      '',
      'Canonical custom prompt',
      'paused',
      'claude-sonnet-4',
      '["Read"]',
      'openrouter',
      '["project"]',
      101
    );
    db.prepare(
      `INSERT INTO space_agents (id, space_id, name, handle, instructions, system_prompt, custom_prompt, status, model, tools, provider, setting_sources, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'conflict-agent-1',
      'space-1',
      'Conflicting Agent',
      'existing-lh',
      '',
      '',
      'Conflict prompt',
      'active',
      null,
      '[]',
      null,
      null,
      102
    );
    db.prepare(
      `INSERT INTO space_long_horizon_agents (
        id, space_id, handle, display_name, status, instructions, tool_permissions_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'active', '', '{}', ?, ?)`
    ).run('lh-agent-1', 'space-1', 'existing-lh', 'Existing LH', 100, 100);
  });

  afterEach(() => {
    db.close();
  });

  test('maps legacy SpaceAgent subscription rows and drops legacy table', () => {
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
    db.prepare(
      `INSERT INTO space_agent_event_subscriptions (space_id, agent_id, topic_pattern, label, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('space-1', 'conflict-agent-1', 'github/lsm/neokai/issues/*.closed', null, 124);

    runMigration151(db);

    expect(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('space_agent_event_subscriptions')
    ).toBeNull();
    expect(
      db
        .prepare(
          `SELECT agent_id, source, topic, filter_json, status, created_at
           FROM space_long_horizon_agent_event_subscriptions
           ORDER BY agent_id`
        )
        .all()
    ).toEqual([
      {
        agent_id: 'conflict-agent-1',
        source: 'github',
        topic: 'github/lsm/neokai/issues/*.closed',
        filter_json: '{}',
        status: 'active',
        created_at: 124,
      },
      {
        agent_id: 'legacy-agent-1',
        source: 'github',
        topic: 'github/lsm/neokai/issues/*.opened',
        filter_json: '{}',
        status: 'active',
        created_at: 123,
      },
      {
        agent_id: 'lh-agent-1',
        source: 'github',
        topic: 'github/lsm/neokai/pull_request/*.review_submitted',
        filter_json: '{"label":"reviews"}',
        status: 'active',
        created_at: 123,
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT id, handle, display_name, template_key, status, instructions, model, provider, setting_sources, tool_permissions_json
           FROM space_long_horizon_agents
           WHERE id = ?`
        )
        .get('legacy-agent-1')
    ).toEqual({
      id: 'legacy-agent-1',
      handle: 'legacy-agent',
      display_name: 'Legacy Agent',
      template_key: 'migration.legacy_space_agent',
      status: 'paused',
      instructions: 'Canonical custom prompt',
      model: 'claude-sonnet-4',
      provider: 'openrouter',
      setting_sources: '["project"]',
      tool_permissions_json: '{"tools":["Read"]}',
    });
    expect(
      db
        .prepare(
          `SELECT id, handle, instructions
           FROM space_long_horizon_agents
           WHERE id = ?`
        )
        .get('conflict-agent-1')
    ).toEqual({
      id: 'conflict-agent-1',
      handle: 'existing-lh-conflict-agent-1',
      instructions: 'Conflict prompt',
    });
  });

  test('is a no-op when legacy table is absent', () => {
    db.exec(`DROP TABLE space_agent_event_subscriptions`);

    expect(() => runMigration151(db)).not.toThrow();
  });
});
