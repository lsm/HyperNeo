import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { runMigration128 } from '../../../../../src/storage/schema/index.ts';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
		CREATE TABLE spaces (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			workspace_path TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
});

describe('Migration 128: external event extension config tables', () => {
  test('creates global source config table with expected columns', () => {
    runMigration128(db);

    const columns = columnNames('external_event_extension_configs');
    expect(columns).toEqual([
      'source',
      'globally_enabled',
      'capabilities_json',
      'secrets_ref',
      'settings_json',
      'created_at',
      'updated_at',
    ]);
  });

  test('creates per-space source config table with cascading space foreign key', () => {
    runMigration128(db);

    const columns = columnNames('space_external_event_source_configs');
    expect(columns).toEqual([
      'space_id',
      'source',
      'enabled',
      'settings_json',
      'created_at',
      'updated_at',
    ]);

    const fks = db
      .prepare(`PRAGMA foreign_key_list('space_external_event_source_configs')`)
      .all() as Array<{
      from: string;
      table: string;
      to: string;
      on_delete: string;
    }>;
    expect(fks).toContainEqual(
      expect.objectContaining({
        from: 'space_id',
        table: 'spaces',
        to: 'id',
        on_delete: 'CASCADE',
      })
    );
  });

  test('copies existing legacy global config rows into renamed table', () => {
    db.exec(`
			CREATE TABLE external_event_source_configs (
				source TEXT PRIMARY KEY,
				globally_enabled INTEGER NOT NULL,
				capabilities_json TEXT,
				secrets_ref TEXT,
				settings_json TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    db.prepare(
      `INSERT INTO external_event_source_configs
			 (source, globally_enabled, capabilities_json, secrets_ref, settings_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('github', 1, JSON.stringify({ polling: true }), 'secret/github', null, 1, 2);

    runMigration128(db);

    const row = db
      .prepare(`SELECT * FROM external_event_extension_configs WHERE source = 'github'`)
      .get() as {
      source: string;
      globally_enabled: number;
      capabilities_json: string;
      secrets_ref: string;
      settings_json: string;
      created_at: number;
      updated_at: number;
    };
    expect(row).toMatchObject({
      source: 'github',
      globally_enabled: 1,
      secrets_ref: 'secret/github',
      settings_json: '{}',
      created_at: 1,
      updated_at: 2,
    });
    expect(JSON.parse(row.capabilities_json)).toEqual({ polling: true, rpcConfig: true });
  });

  test.each([
    ['malformed JSON', '{not valid json'],
    ['array JSON', '[]'],
    ['string JSON', '"x"'],
    ['number JSON', '123'],
  ])('falls back to empty capabilities when legacy capabilities JSON is %s', (_label, rawJson) => {
    db.exec(`
			CREATE TABLE external_event_source_configs (
				source TEXT PRIMARY KEY,
				globally_enabled INTEGER NOT NULL,
				capabilities_json TEXT,
				secrets_ref TEXT,
				settings_json TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    db.prepare(
      `INSERT INTO external_event_source_configs
			 (source, globally_enabled, capabilities_json, secrets_ref, settings_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('github', 1, rawJson, null, null, 1, 2);

    expect(() => runMigration128(db)).not.toThrow();
    const row = db
      .prepare(
        `SELECT capabilities_json FROM external_event_extension_configs WHERE source = 'github'`
      )
      .get() as { capabilities_json: string };
    expect(JSON.parse(row.capabilities_json)).toEqual({ rpcConfig: true });
  });

  test('seeds GitHub polling disabled by default', () => {
    runMigration128(db);

    const row = db
      .prepare(
        `SELECT capabilities_json FROM external_event_extension_configs WHERE source = 'github'`
      )
      .get() as { capabilities_json: string };
    expect(JSON.parse(row.capabilities_json)).toEqual({
      webhooks: true,
      polling: false,
      rpcConfig: true,
    });
  });

  test('is idempotent', () => {
    runMigration128(db);
    expect(() => runMigration128(db)).not.toThrow();
  });
});

function columnNames(table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}
