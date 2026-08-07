/**
 * Migration 12 Tests
 *
 * Tests for Migration 12: Ensure global_settings has autoScroll: true
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration12 } from '../../../../../src/storage/schema/index.ts';

describe('Migration 12: autoScroll default in global_settings', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    // Create temp directory for test database
    testDir = join(process.cwd(), 'tmp', 'test-migration-12', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Create test database
    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);

    // Enable WAL mode
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');

    // Create global_settings table
    db.exec(`
      CREATE TABLE IF NOT EXISTS global_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  });

  test('inserts autoScroll: true when global_settings row does not exist', () => {
    // Verify no row exists
    const row = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get();
    expect(row).toBeNull();

    // Run migration
    runMigration12(db);

    // Verify row was created with autoScroll: true
    const result = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as {
      settings: string;
    };
    expect(result).toBeDefined();
    const settings = JSON.parse(result.settings) as Record<string, unknown>;
    expect(settings.autoScroll).toBe(true);
  });

  test('adds autoScroll: true to existing global_settings without autoScroll', () => {
    // Insert a row without autoScroll
    db.exec(`
      INSERT INTO global_settings (id, settings, updated_at)
      VALUES (1, '{"model":"claude-haiku-3-5-20241022"}', datetime('now'))
    `);

    // Verify autoScroll is not set
    const before = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as {
      settings: string;
    };
    const beforeSettings = JSON.parse(before.settings) as Record<string, unknown>;
    expect(beforeSettings.autoScroll).toBeUndefined();

    // Run migration
    runMigration12(db);

    // Verify autoScroll was added
    const after = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as {
      settings: string;
    };
    const afterSettings = JSON.parse(after.settings) as Record<string, unknown>;
    expect(afterSettings.autoScroll).toBe(true);
    // Other fields should be preserved
    expect(afterSettings.model).toBe('claude-haiku-3-5-20241022');
  });

  test('does not modify global_settings when autoScroll is already set to true', () => {
    // Insert a row with autoScroll: true
    db.exec(`
      INSERT INTO global_settings (id, settings, updated_at)
      VALUES (1, '{"autoScroll":true,"model":"claude-sonnet-4-5-20250514"}', datetime('now'))
    `);

    // Get the original updated_at
    const before = db.prepare(`SELECT updated_at FROM global_settings WHERE id = 1`).get() as {
      updated_at: string;
    };

    // Run migration
    runMigration12(db);

    // Verify settings were not modified (updated_at should be the same)
    const after = db
      .prepare(`SELECT settings, updated_at FROM global_settings WHERE id = 1`)
      .get() as {
      settings: string;
      updated_at: string;
    };
    expect(after.updated_at).toBe(before.updated_at);
    const settings = JSON.parse(after.settings) as Record<string, unknown>;
    expect(settings.autoScroll).toBe(true);
    expect(settings.model).toBe('claude-sonnet-4-5-20250514');
  });

  test('does not modify global_settings when autoScroll is already set to false', () => {
    // Insert a row with autoScroll: false (user explicitly disabled it)
    db.exec(`
      INSERT INTO global_settings (id, settings, updated_at)
      VALUES (1, '{"autoScroll":false,"model":"claude-opus-4-5-20251101"}', datetime('now'))
    `);

    // Get the original updated_at
    const before = db.prepare(`SELECT updated_at FROM global_settings WHERE id = 1`).get() as {
      updated_at: string;
    };

    // Run migration
    runMigration12(db);

    // Verify settings were not modified (autoScroll should stay false)
    const after = db
      .prepare(`SELECT settings, updated_at FROM global_settings WHERE id = 1`)
      .get() as {
      settings: string;
      updated_at: string;
    };
    expect(after.updated_at).toBe(before.updated_at);
    const settings = JSON.parse(after.settings) as Record<string, unknown>;
    expect(settings.autoScroll).toBe(false);
    expect(settings.model).toBe('claude-opus-4-5-20251101');
  });

  test('preserves other settings fields when adding autoScroll', () => {
    // Insert a row with multiple settings but no autoScroll
    db.exec(`
      INSERT INTO global_settings (id, settings, updated_at)
      VALUES (1, '{"model":"test-model","permissionMode":"acceptEdits","maxThinkingTokens":5000}', datetime('now'))
    `);

    // Run migration
    runMigration12(db);

    // Verify all fields were preserved
    const result = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as {
      settings: string;
    };
    const settings = JSON.parse(result.settings) as Record<string, unknown>;
    expect(settings.autoScroll).toBe(true);
    expect(settings.model).toBe('test-model');
    expect(settings.permissionMode).toBe('acceptEdits');
    expect(settings.maxThinkingTokens).toBe(5000);
  });

  test('handles malformed JSON in existing global_settings gracefully', () => {
    // Insert a row with invalid JSON
    db.exec(`
      INSERT INTO global_settings (id, settings, updated_at)
      VALUES (1, '{invalid json}', datetime('now'))
    `);

    // Run migration - should not throw
    runMigration12(db);

    // Row should still exist (migration handles error gracefully)
    const result = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as {
      settings: string;
    };
    expect(result).toBeDefined();
    expect(result.settings).toBe('{invalid json}');
  });

  // Cleanup helper
  afterEach(() => {
    try {
      db.close();
    } catch {
      // Ignore errors
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  });
});
