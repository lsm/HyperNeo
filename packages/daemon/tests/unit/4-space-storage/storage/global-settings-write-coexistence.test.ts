import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { SettingsRepository } from '../../../../src/storage/repositories/settings-repository.ts';

describe('SettingsRepository concurrent patch ownership', () => {
  it('retains a competing connection commit just before the legacy write executes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hn-settings-coexist-'));
    const db = new Database(join(directory, 'settings.db'));
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE global_settings (id INTEGER PRIMARY KEY, settings TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const other = new Database(join(directory, 'settings.db'));
    const repository = new SettingsRepository(db);
    const competitor = new SettingsRepository(other);
    repository.updateGlobalSettings({ showArchived: false, autoScroll: true });
    const prepare = db.prepare.bind(db);
    let commits = 0;
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (!/INSERT.*global_settings/is.test(sql)) return statement;
      for (const method of ['get', 'run'] as const) {
        const execute = statement[method].bind(statement);
        Reflect.set(statement, method, (...args: unknown[]) => {
          if (commits++ === 0) competitor.updateGlobalSettings({ autoScroll: false });
          return Reflect.apply(execute, statement, args);
        });
      }
      return statement;
    }) as typeof db.prepare;
    try {
      const result = repository.updateGlobalSettings({ showArchived: true });
      expect(commits).toBe(1);
      expect(result.showArchived).toBe(true);
      expect(result.autoScroll).toBe(false);
      expect(competitor.getGlobalSettings().autoScroll).toBe(false);
    } finally {
      db.close();
      other.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
