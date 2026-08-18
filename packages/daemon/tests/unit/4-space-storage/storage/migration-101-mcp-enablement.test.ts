import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigration101 } from '../../../../src/storage/schema';

function createMinimalSchema(db: BunDatabase): void {
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
		CREATE TABLE IF NOT EXISTS app_mcp_servers (
			id TEXT PRIMARY KEY,
			name TEXT UNIQUE NOT NULL,
			source_type TEXT NOT NULL,
			command TEXT,
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at INTEGER,
			updated_at INTEGER
		)
	`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS rooms (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS room_mcp_enablement (
			room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
			server_id TEXT NOT NULL REFERENCES app_mcp_servers(id) ON DELETE CASCADE,
			enabled INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (room_id, server_id)
		)
	`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS spaces (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS global_settings (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			settings TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL DEFAULT '',
			config TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL DEFAULT '',
			last_active_at TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active',
			metadata TEXT NOT NULL DEFAULT '{}'
		)
	`);
}

function insertServer(db: BunDatabase, id: string, name: string): void {
  db.prepare(
    `INSERT INTO app_mcp_servers (id, name, source_type, enabled) VALUES (?, ?, 'stdio', 1)`
  ).run(id, name);
}

function insertRoom(db: BunDatabase, id: string): void {
  db.prepare(`INSERT INTO rooms (id, name, created_at, updated_at) VALUES (?, ?, 0, 0)`).run(
    id,
    id
  );
}

function insertSpace(db: BunDatabase, id: string, status: 'active' | 'archived' = 'active'): void {
  db.prepare(
    `INSERT INTO spaces (id, name, status, created_at, updated_at) VALUES (?, ?, ?, 0, 0)`
  ).run(id, id, status);
}

function setGlobalSettings(db: BunDatabase, settings: Record<string, unknown>): void {
  db.prepare(
    `INSERT OR REPLACE INTO global_settings (id, settings, updated_at) VALUES (1, ?, '')`
  ).run(JSON.stringify(settings));
}

function insertSession(db: BunDatabase, id: string, config: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO sessions (id, config, created_at, last_active_at) VALUES (?, ?, '', '')`
  ).run(id, JSON.stringify(config));
}

describe('Migration 100: mcp_enablement seeding', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createMinimalSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test('creates the mcp_enablement table with the expected shape', () => {
    runMigration101(db);

    const tbl = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_enablement'`)
      .get();
    expect(tbl).not.toBeNull();

    const cols = db.prepare(`PRAGMA table_info(mcp_enablement)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['enabled', 'scope_id', 'scope_type', 'server_id'].sort());

    insertServer(db, 'srv-1', 'srv-1');
    db.prepare(
      `INSERT INTO mcp_enablement (server_id, scope_type, scope_id, enabled)
			 VALUES ('srv-1', 'space', 'sp-1', 0)`
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO mcp_enablement (server_id, scope_type, scope_id, enabled)
					 VALUES ('srv-1', 'space', 'sp-1', 0)`
        )
        .run()
    ).toThrow();
  }, 15000);

  test('is idempotent when run twice on an empty database', () => {
    runMigration101(db);
    expect(() => runMigration101(db)).not.toThrow();
  });

  test('copies room_mcp_enablement rows as scope=room overrides', () => {
    insertServer(db, 'srv-1', 'srv-1');
    insertRoom(db, 'room-1');
    db.prepare(
      `INSERT INTO room_mcp_enablement (room_id, server_id, enabled) VALUES ('room-1', 'srv-1', 0)`
    ).run();

    runMigration101(db);

    const rows = db
      .prepare(`SELECT scope_type, scope_id, server_id, enabled FROM mcp_enablement`)
      .all() as Array<{
      scope_type: string;
      scope_id: string;
      server_id: string;
      enabled: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      scope_type: 'room',
      scope_id: 'room-1',
      server_id: 'srv-1',
      enabled: 0,
    });
  });

  test('does not duplicate scope=room rows on re-run', () => {
    insertServer(db, 'srv-1', 'srv-1');
    insertRoom(db, 'room-1');
    db.prepare(
      `INSERT INTO room_mcp_enablement (room_id, server_id, enabled) VALUES ('room-1', 'srv-1', 1)`
    ).run();

    runMigration101(db);
    runMigration101(db);

    const count = (db.prepare(`SELECT COUNT(*) AS c FROM mcp_enablement`).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test('seeds scope=space disable rows for every active space from global settings', () => {
    insertServer(db, 'srv-1', 'test-search');
    insertServer(db, 'srv-2', 'playwright');
    insertSpace(db, 'space-active-1');
    insertSpace(db, 'space-active-2');
    insertSpace(db, 'space-archived', 'archived');
    setGlobalSettings(db, { disabledMcpServers: ['test-search', 'playwright'] });

    runMigration101(db);

    const spaceRows = db
      .prepare(
        `SELECT scope_id, server_id, enabled FROM mcp_enablement WHERE scope_type='space' ORDER BY scope_id, server_id`
      )
      .all() as Array<{ scope_id: string; server_id: string; enabled: number }>;
    expect(spaceRows).toHaveLength(4);
    for (const row of spaceRows) {
      expect(row.enabled).toBe(0);
      expect(['space-active-1', 'space-active-2']).toContain(row.scope_id);
    }

    const archivedCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM mcp_enablement WHERE scope_type='space' AND scope_id='space-archived'`
        )
        .get() as { c: number }
    ).c;
    expect(archivedCount).toBe(0);
  });

  test('silently skips disabledMcpServers entries with no matching registry row', () => {
    insertServer(db, 'srv-1', 'real-server');
    insertSpace(db, 'space-1');
    setGlobalSettings(db, { disabledMcpServers: ['real-server', 'ghost-server'] });

    runMigration101(db);

    const rows = db
      .prepare(`SELECT server_id FROM mcp_enablement WHERE scope_type='space'`)
      .all() as Array<{ server_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].server_id).toBe('srv-1');
  });

  test('does nothing when global settings has no disabledMcpServers', () => {
    insertSpace(db, 'space-1');
    setGlobalSettings(db, { some: 'other', shape: 123 });

    runMigration101(db);

    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM mcp_enablement WHERE scope_type='space'`)
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });

  test('tolerates malformed global_settings JSON without throwing', () => {
    insertSpace(db, 'space-1');
    db.prepare(
      `INSERT OR REPLACE INTO global_settings (id, settings, updated_at) VALUES (1, ?, '')`
    ).run('not-json {{');

    expect(() => runMigration101(db)).not.toThrow();
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM mcp_enablement WHERE scope_type='space'`)
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });

  test('seeds scope=session disable rows for each session', () => {
    insertServer(db, 'srv-1', 'test-search');
    insertServer(db, 'srv-2', 'playwright');
    insertSession(db, 'sess-a', { tools: { disabledMcpServers: ['test-search'] } });
    insertSession(db, 'sess-b', {
      tools: { disabledMcpServers: ['test-search', 'playwright'] },
    });
    insertSession(db, 'sess-c', {});

    runMigration101(db);

    const rows = db
      .prepare(
        `SELECT scope_id, server_id, enabled FROM mcp_enablement WHERE scope_type='session' ORDER BY scope_id, server_id`
      )
      .all() as Array<{ scope_id: string; server_id: string; enabled: number }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.enabled === 0)).toBe(true);

    const perSession = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.scope_id] = (acc[r.scope_id] ?? 0) + 1;
      return acc;
    }, {});
    expect(perSession).toEqual({ 'sess-a': 1, 'sess-b': 2 });
  });

  test('tolerates malformed session.config JSON without throwing', () => {
    insertServer(db, 'srv-1', 'srv-1');
    db.prepare(
      `INSERT INTO sessions (id, title, config, created_at, last_active_at) VALUES ('bad', '', 'not-json', '', '')`
    ).run();
    insertSession(db, 'good', { tools: { disabledMcpServers: ['srv-1'] } });

    expect(() => runMigration101(db)).not.toThrow();

    const rows = db
      .prepare(`SELECT scope_id FROM mcp_enablement WHERE scope_type='session'`)
      .all() as Array<{ scope_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].scope_id).toBe('good');
  });

  test('seeds rows for room, space, and session sources in a single run', () => {
    insertServer(db, 'srv-1', 'test-search');
    insertRoom(db, 'room-1');
    db.prepare(
      `INSERT INTO room_mcp_enablement (room_id, server_id, enabled) VALUES ('room-1', 'srv-1', 1)`
    ).run();
    insertSpace(db, 'space-1');
    setGlobalSettings(db, { disabledMcpServers: ['test-search'] });
    insertSession(db, 'sess-1', { tools: { disabledMcpServers: ['test-search'] } });

    runMigration101(db);

    const byScope = db
      .prepare(`SELECT scope_type, COUNT(*) AS c FROM mcp_enablement GROUP BY scope_type`)
      .all() as Array<{ scope_type: string; c: number }>;
    const map = Object.fromEntries(byScope.map((r) => [r.scope_type, r.c]));
    expect(map).toEqual({ room: 1, space: 1, session: 1 });
  });
});
