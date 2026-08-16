/**
 * Shared DB fixtures for migration test files.
 *
 * Building a fully-migrated DB replays the whole migration chain (~0.5–0.7s
 * warm, several seconds on a loaded CI runner under coverage). Doing that
 * inside every test made the per-test budget marginal — the migration-29
 * timeout flakes registered in flaky-tests.json. Build the template once per
 * file (beforeAll) and clone it per test (~1ms) instead.
 *
 * Tests that construct legacy pre-migration state cannot run against a
 * fully-migrated clone — they call openEmptyDb() to reset first, then replay
 * the chain themselves.
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';

/** Build a fully-migrated template DB and return its path. */
export function buildMigratedTemplate(templateDir: string): string {
  mkdirSync(templateDir, { recursive: true });
  const templatePath = join(templateDir, 'template.db');
  const template = new BunDatabase(templatePath);
  try {
    template.exec('PRAGMA foreign_keys = ON');
    runMigrations(template, () => {});
  } finally {
    template.close();
  }
  return templatePath;
}

/** Clone the template into testDir and open it. */
export function openMigratedClone(templatePath: string, testDir: string): BunDatabase {
  mkdirSync(testDir, { recursive: true });
  copyFileSync(templatePath, join(testDir, 'test.db'));
  const db = new BunDatabase(join(testDir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** Replace the cloned DB in testDir with an empty one. */
export function openEmptyDb(testDir: string): BunDatabase {
  rmSync(join(testDir, 'test.db'), { force: true });
  const db = new BunDatabase(join(testDir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
