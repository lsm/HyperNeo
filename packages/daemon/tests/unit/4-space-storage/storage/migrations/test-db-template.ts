import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';

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

export function openMigratedClone(templatePath: string, testDir: string): BunDatabase {
  mkdirSync(testDir, { recursive: true });
  copyFileSync(templatePath, join(testDir, 'test.db'));
  const db = new BunDatabase(join(testDir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export function openEmptyDb(testDir: string): BunDatabase {
  rmSync(join(testDir, 'test.db'), { force: true });
  const db = new BunDatabase(join(testDir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
