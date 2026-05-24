/**
 * Migration 102 Tests — M5 of `unify-mcp-config-model`.
 *
 * Migration 102 strips legacy MCP keys from the `global_settings` JSON blob:
 *   - `disabledMcpServers`
 *   - `mcpServerSettings`
 *   - `enabledMcpServers`
 *   - `enableAllProjectMcpServers`
 *
 * The TypeScript fields were dropped in M5 (`packages/shared/src/types/settings.ts`).
 * On the next read after this migration the JSON blob won't carry these keys
 * back in.
 *
 * Order matters: M102 runs *after* M101 — which seeds the new `mcp_enablement`
 * table from the same legacy keys — so that the data is preserved before being
 * stripped from the JSON blob.
 *
 * Covers:
 *   - The four legacy keys are stripped from a pre-existing JSON blob.
 *   - Other keys in the blob are preserved verbatim.
 *   - When none of the legacy keys are present, the blob is left untouched
 *     (no UPDATE is fired).
 *   - When the `global_settings` table doesn't exist, the migration is a no-op.
 *   - When the `global_settings` table is empty (no row), the migration is a no-op.
 *   - Malformed JSON is swallowed (does not throw).
 *   - Idempotent — running the migration twice is a no-op.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration102 } from '../../../../../src/storage/schema/migrations.ts';

function createGlobalSettingsTable(db: BunDatabase): void {
  db.exec(
    `CREATE TABLE global_settings (
			id INTEGER PRIMARY KEY,
			settings TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`
  );
}

function insertSettingsBlob(db: BunDatabase, blob: Record<string, unknown>): void {
  db.prepare(`INSERT INTO global_settings (id, settings) VALUES (1, ?)`).run(JSON.stringify(blob));
}

function readSettingsBlob(db: BunDatabase): Record<string, unknown> | null {
  const row = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as
    | { settings: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.settings) as Record<string, unknown>;
}

describe('Migration 102: strip legacy MCP keys from global_settings JSON blob', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-102',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('strips all four legacy MCP keys when present', () => {
    createGlobalSettingsTable(db);
    insertSettingsBlob(db, {
      model: 'sonnet',
      autoScroll: true,
      disabledMcpServers: ['chrome-devtools', 'github'],
      mcpServerSettings: {
        'chrome-devtools': { allowed: false, defaultOn: false },
      },
      enabledMcpServers: ['filesystem'],
      enableAllProjectMcpServers: true,
    });

    runMigration102(db);

    const after = readSettingsBlob(db);
    expect(after).not.toBeNull();
    expect(after).not.toHaveProperty('disabledMcpServers');
    expect(after).not.toHaveProperty('mcpServerSettings');
    expect(after).not.toHaveProperty('enabledMcpServers');
    expect(after).not.toHaveProperty('enableAllProjectMcpServers');
  });

  test('preserves non-legacy keys verbatim', () => {
    createGlobalSettingsTable(db);
    insertSettingsBlob(db, {
      model: 'sonnet',
      autoScroll: true,
      thinkingLevel: 'think16k',
      settingSources: ['user', 'project', 'local'],
      disabledMcpServers: ['x'],
      mcpServerSettings: { y: { allowed: false } },
    });

    runMigration102(db);

    const after = readSettingsBlob(db);
    expect(after).toMatchObject({
      model: 'sonnet',
      autoScroll: true,
      thinkingLevel: 'think16k',
      settingSources: ['user', 'project', 'local'],
    });
  });

  test('strips a subset of legacy keys correctly when only some are present', () => {
    createGlobalSettingsTable(db);
    insertSettingsBlob(db, {
      model: 'opus',
      disabledMcpServers: ['x'],
      // only one of the four legacy keys present
    });

    runMigration102(db);

    const after = readSettingsBlob(db);
    expect(after).toEqual({ model: 'opus' });
  });

  test('leaves the blob untouched when no legacy keys are present', () => {
    createGlobalSettingsTable(db);
    insertSettingsBlob(db, {
      model: 'sonnet',
      autoScroll: false,
    });

    runMigration102(db);

    const after = readSettingsBlob(db);
    expect(after).toEqual({ model: 'sonnet', autoScroll: false });
  });

  test('is a no-op when the global_settings table does not exist', () => {
    // No table created — migration must not throw and must not create one.
    expect(() => runMigration102(db)).not.toThrow();
    const tableRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='global_settings'`)
      .get();
    // Bun's bun:sqlite returns `null` (not `undefined`) for an empty .get().
    expect(tableRow).toBeNull();
  });

  test('is a no-op when the global_settings table is empty (no row)', () => {
    createGlobalSettingsTable(db);
    expect(() => runMigration102(db)).not.toThrow();
    const row = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get();
    expect(row).toBeNull();
  });

  test('swallows malformed JSON without throwing', () => {
    createGlobalSettingsTable(db);
    db.prepare(`INSERT INTO global_settings (id, settings) VALUES (1, ?)`).run(
      'this-is-not-valid-json'
    );

    expect(() => runMigration102(db)).not.toThrow();

    // Row is still present and untouched (the migration's catch swallows the parse error).
    const row = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as {
      settings: string;
    };
    expect(row.settings).toBe('this-is-not-valid-json');
  });

  test('is idempotent — second run is a no-op', () => {
    createGlobalSettingsTable(db);
    insertSettingsBlob(db, {
      model: 'sonnet',
      disabledMcpServers: ['x'],
      mcpServerSettings: { y: { allowed: false } },
    });

    runMigration102(db);
    const after1 = readSettingsBlob(db);

    runMigration102(db);
    const after2 = readSettingsBlob(db);

    expect(after1).toEqual({ model: 'sonnet' });
    expect(after2).toEqual({ model: 'sonnet' });
  });
});
