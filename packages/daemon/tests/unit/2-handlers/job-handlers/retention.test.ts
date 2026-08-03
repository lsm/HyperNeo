import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  incrementalVacuum,
  loadRetentionConfig,
  runRetention,
} from '../../../../src/lib/job-handlers/retention';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Minimal schema for the retention-target tables. Mirrors the production DDL
 * (CHECK constraints, FKs, epoch-ms timestamp columns) closely enough to
 * exercise the delete queries. `spaces` exists so the external_events FK resolves.
 */
function createRetentionSchema(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY)`);
  db.exec(`INSERT INTO spaces (id) VALUES ('sp1')`);

  db.exec(`
    CREATE TABLE space_external_events (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      source TEXT NOT NULL,
      topic TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'published'
        CHECK(state IN ('published','routed','delivered','delivery_failed','failed','ignored','ambiguous')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(space_id, source, dedupe_key),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE space_external_event_deliveries (
      event_id TEXT NOT NULL,
      delivery_key TEXT NOT NULL,
      workflow_run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','failed')),
      failure_reason TEXT,
      delivered_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(event_id, delivery_key),
      FOREIGN KEY (event_id) REFERENCES space_external_events(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE space_github_events (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      task_id TEXT,
      source TEXT NOT NULL CHECK(source IN ('webhook','polling')),
      delivery_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      action TEXT NOT NULL,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      pr_url TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      raw_payload TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'received'
        CHECK(state IN ('received','processed','ignored','ambiguous','routed','delivered','failed')),
      occurred_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(space_id, dedupe_key)
    )
  `);

  db.exec(`
    CREATE TABLE mcp_audit_log (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      tool_name TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE space_goal_events (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

function insertExternalEvent(db: Database, id: string, state: string, ageDays: number): void {
  const now = Date.now();
  db.exec(
    `INSERT INTO space_external_events (id, space_id, source, topic, dedupe_key, occurred_at, ingested_at, state, created_at, updated_at)
     VALUES (?, 'sp1', 'github', 'topic', ?, ?, ?, ?, ?, ?)`,
    [id, id, now, now, state, now, now - ageDays * DAY]
  );
}

function insertDelivery(
  db: Database,
  eventId: string,
  key: string,
  state: string,
  ageDays: number
): void {
  const now = Date.now();
  db.exec(
    `INSERT INTO space_external_event_deliveries (event_id, delivery_key, workflow_run_id, task_id, node_id, agent_name, state, updated_at)
     VALUES (?, ?, 'run', 'task', 'node', 'agent', ?, ?)`,
    [eventId, key, state, now - ageDays * DAY]
  );
}

function insertGithubEvent(db: Database, id: string, state: string, ageDays: number): void {
  const now = Date.now();
  db.exec(
    `INSERT INTO space_github_events (id, space_id, source, delivery_id, event_type, action, repo_owner, repo_name, pr_number, pr_url, actor, actor_type, dedupe_key, state, occurred_at, created_at, updated_at)
     VALUES (?, 'sp1', 'polling', ?, 'push', 'opened', 'o', 'r', 1, 'url', 'a', 'user', ?, ?, ?, ?, ?)`,
    [id, id, id, state, now, now, now - ageDays * DAY]
  );
}

function insertAudit(db: Database, id: string, ageDays: number): void {
  db.exec(`INSERT INTO mcp_audit_log (id, timestamp, tool_name) VALUES (?, ?, 't')`, [
    id,
    Date.now() - ageDays * DAY,
  ]);
}

function insertGoalEvent(db: Database, id: string, ageDays: number): void {
  db.exec(
    `INSERT INTO space_goal_events (id, space_id, goal_id, event_type, source, created_at) VALUES (?, 'sp1', 'g1', 'created', 'system', ?)`,
    [id, Date.now() - ageDays * DAY]
  );
}

function count(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
}

describe('retention', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createRetentionSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('runRetention (enabled)', () => {
    const config = {
      enabled: true,
      eventsDays: 14,
      mcpAuditDays: 30,
      goalEventsDays: 60,
      vacuumPages: 0, // disable vacuum in these pure-deletion tests
    };

    it('prunes old terminal external events, keeps recent + in-flight', () => {
      insertExternalEvent(db, 'old-delivered', 'delivered', 20); // pruned
      insertExternalEvent(db, 'old-routed', 'routed', 20); // in-flight: kept
      insertExternalEvent(db, 'new-delivered', 'delivered', 1); // recent: kept
      insertExternalEvent(db, 'new-published', 'published', 1); // in-flight: kept

      const stats = runRetention(db, config);

      expect(stats.externalEvents).toBe(1);
      expect(count(db, 'space_external_events')).toBe(3);
      expect(
        db.prepare(`SELECT id FROM space_external_events WHERE id = 'old-delivered'`).get()
      ).toBeNull();
    });

    it('cascades delivery rows when their terminal event is pruned', () => {
      insertExternalEvent(db, 'old-delivered', 'delivered', 20);
      insertDelivery(db, 'old-delivered', 'd1', 'delivered', 20); // cascade-deleted
      insertExternalEvent(db, 'kept-routed', 'routed', 1);
      insertDelivery(db, 'kept-routed', 'd2', 'delivered', 1); // kept (recent)

      const stats = runRetention(db, config);

      // d1 is gone via FK cascade (not counted in the independent delivery stat);
      // the recent d2 under the kept event remains.
      expect(stats.externalEvents).toBe(1);
      expect(count(db, 'space_external_event_deliveries')).toBe(1);
    });

    it('independently prunes old terminal deliveries under a kept event', () => {
      // Kept (in-flight routed) event, but with an old resolved delivery.
      insertExternalEvent(db, 'routed', 'routed', 1);
      insertDelivery(db, 'routed', 'old-d', 'delivered', 20); // pruned independently
      insertDelivery(db, 'routed', 'new-d', 'delivered', 1); // kept

      const stats = runRetention(db, config);

      expect(stats.deliveries).toBe(1);
      expect(count(db, 'space_external_event_deliveries')).toBe(1);
    });

    it('prunes old terminal github events, keeps recent + in-flight', () => {
      insertGithubEvent(db, 'old-processed', 'processed', 20); // pruned
      insertGithubEvent(db, 'old-received', 'received', 20); // in-flight: kept
      insertGithubEvent(db, 'new-processed', 'processed', 1); // recent: kept

      const stats = runRetention(db, config);

      expect(stats.githubEvents).toBe(1);
      expect(count(db, 'space_github_events')).toBe(2);
    });

    it('prunes old mcp_audit_log by its own TTL', () => {
      insertAudit(db, 'old', 40); // > 30d: pruned
      insertAudit(db, 'recent', 5); // kept

      const stats = runRetention(db, config);

      expect(stats.mcpAudit).toBe(1);
      expect(count(db, 'mcp_audit_log')).toBe(1);
    });

    it('prunes old space_goal_events by its own TTL', () => {
      insertGoalEvent(db, 'old', 90); // > 60d: pruned
      insertGoalEvent(db, 'recent', 10); // kept

      const stats = runRetention(db, config);

      expect(stats.goalEvents).toBe(1);
      expect(count(db, 'space_goal_events')).toBe(1);
    });
  });

  describe('runRetention (disabled)', () => {
    it('deletes nothing when enabled=false', () => {
      insertExternalEvent(db, 'old-delivered', 'delivered', 200);
      insertGithubEvent(db, 'old-processed', 'processed', 200);
      insertAudit(db, 'old', 200);
      insertGoalEvent(db, 'old', 200);

      const stats = runRetention(db, {
        enabled: false,
        eventsDays: 14,
        mcpAuditDays: 30,
        goalEventsDays: 60,
        vacuumPages: 0,
      });

      expect(stats.externalEvents).toBe(0);
      expect(stats.githubEvents).toBe(0);
      expect(stats.mcpAudit).toBe(0);
      expect(stats.goalEvents).toBe(0);
      expect(count(db, 'space_external_events')).toBe(1);
    });
  });

  describe('missing tables', () => {
    it('skips absent tables without error', () => {
      const minimal = new Database(':memory:');
      minimal.exec('PRAGMA foreign_keys = ON');
      // Only one of the target tables exists.
      minimal.exec(`CREATE TABLE mcp_audit_log (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL)`);
      minimal.exec(`INSERT INTO mcp_audit_log (id, timestamp) VALUES ('x', 0)`);

      const stats = runRetention(minimal, {
        enabled: true,
        eventsDays: 14,
        mcpAuditDays: 30,
        goalEventsDays: 60,
        vacuumPages: 0,
      });

      expect(stats.mcpAudit).toBe(1);
      expect(stats.externalEvents).toBe(0); // table absent → 0, no throw
      minimal.close();
    });
  });

  describe('incrementalVacuum', () => {
    it('is a no-op (returns 0) on a non-incremental DB', () => {
      // Fresh in-memory DB defaults to auto_vacuum = NONE (0).
      const none = new Database(':memory:');
      none.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)');
      none.exec(`INSERT INTO t (blob) VALUES ('x')`);
      expect(incrementalVacuum(none, 500)).toBe(0);
      none.close();
    });

    it('reclaims freed pages on an incremental DB', () => {
      const inc = new Database(':memory:');
      // Must be set before any table is created to take effect.
      inc.exec('PRAGMA auto_vacuum = INCREMENTAL');
      inc.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)');
      for (let i = 0; i < 3000; i++) {
        inc.prepare('INSERT INTO t (blob) VALUES (?)').run('x'.repeat(3000));
      }
      inc.exec('DELETE FROM t WHERE id > 100');

      const beforePages = (inc.prepare('PRAGMA page_count').get() as { page_count: number })
        .page_count;
      const freed = incrementalVacuum(inc, 500);
      const afterPages = (inc.prepare('PRAGMA page_count').get() as { page_count: number })
        .page_count;

      expect(freed).toBeGreaterThan(0);
      expect(freed).toBeLessThanOrEqual(500);
      expect(afterPages).toBeLessThan(beforePages);
      inc.close();
    });

    it('returns 0 when vacuumPages <= 0', () => {
      const inc = new Database(':memory:');
      inc.exec('PRAGMA auto_vacuum = INCREMENTAL');
      inc.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      expect(incrementalVacuum(inc, 0)).toBe(0);
      inc.close();
    });
  });

  describe('loadRetentionConfig', () => {
    const keys = [
      'HYPERNEO_RETENTION_ENABLED',
      'HYPERNEO_RETENTION_EVENTS_DAYS',
      'HYPERNEO_RETENTION_MCP_AUDIT_DAYS',
      'HYPERNEO_RETENTION_GOAL_EVENTS_DAYS',
      'HYPERNEO_RETENTION_VACUUM_PAGES',
    ];
    const original = keys.map((k) => process.env[k]);

    afterEach(() => {
      keys.forEach((k, i) => {
        if (original[i] === undefined) delete process.env[k];
        else process.env[k] = original[i];
      });
    });

    it('defaults to disabled with conservative TTLs', () => {
      for (const k of keys) delete process.env[k];
      const cfg = loadRetentionConfig();
      expect(cfg.enabled).toBe(false);
      expect(cfg.eventsDays).toBe(14);
      expect(cfg.mcpAuditDays).toBe(30);
      expect(cfg.goalEventsDays).toBe(60);
      expect(cfg.vacuumPages).toBe(500);
    });

    it('parses enabled flags and overrides', () => {
      process.env.HYPERNEO_RETENTION_ENABLED = '1';
      process.env.HYPERNEO_RETENTION_EVENTS_DAYS = '7';
      process.env.HYPERNEO_RETENTION_MCP_AUDIT_DAYS = '10';
      process.env.HYPERNEO_RETENTION_GOAL_EVENTS_DAYS = '90';
      process.env.HYPERNEO_RETENTION_VACUUM_PAGES = '250';
      const cfg = loadRetentionConfig();
      expect(cfg).toEqual({
        enabled: true,
        eventsDays: 7,
        mcpAuditDays: 10,
        goalEventsDays: 90,
        vacuumPages: 250,
      });
    });

    it('falls back to defaults on invalid input', () => {
      process.env.HYPERNEO_RETENTION_ENABLED = 'yes'; // not 1/true → false
      process.env.HYPERNEO_RETENTION_EVENTS_DAYS = 'not-a-number';
      process.env.HYPERNEO_RETENTION_VACUUM_PAGES = '-5';
      const cfg = loadRetentionConfig();
      expect(cfg.enabled).toBe(false);
      expect(cfg.eventsDays).toBe(14); // default
      expect(cfg.vacuumPages).toBe(500); // default
    });
  });
});
