import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store.ts';
import { GitHubEventExtensionRepository } from '../../../../src/lib/external-events/github/github-repository.ts';
import { runMigration128 } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('external event config with Space tables absent', () => {
  let db: Database;
  const tables = () =>
    (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[])
      .map((row) => row.name)
      .sort();

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE space_github_watched_repos (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, polling_enabled INTEGER NOT NULL DEFAULT 0
    )`);
  });
  afterEach(() => db.close());

  it('reads no Space config, drops Space writes and creates no Space table', async () => {
    const store = new ExternalEventExtensionConfigStore(db);
    await store.setSpaceConfig('sessions', 'github', {
      spaceId: 'sessions',
      source: 'github',
      enabled: true,
      settings: {},
    });
    expect(await store.getSpaceConfig('sessions', 'github')).toBeNull();
    expect(await store.listEnabledSpaces('github')).toEqual([]);
    expect(tables()).toEqual(['space_github_watched_repos']);
  });

  it('drops Space writes when migration 128 left the table with a dangling foreign key', async () => {
    db.exec('PRAGMA foreign_keys = ON');
    runMigration128(db);
    const store = new ExternalEventExtensionConfigStore(db);
    await store.setSpaceConfig('sessions', 'github', {
      spaceId: 'sessions',
      source: 'github',
      enabled: true,
      settings: {},
    });
    expect(await store.getSpaceConfig('sessions', 'github')).toBeNull();
    expect(tables()).toContain('space_external_event_source_configs');
  });

  it('skips the polling intent backfill that joins spaces', () => {
    db.prepare(
      `INSERT INTO space_github_watched_repos (id, space_id, polling_enabled) VALUES ('r', 'sessions', 1)`
    ).run();
    new GitHubEventExtensionRepository(db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM space_github_source_settings').get()).toEqual({
      count: 0,
    });
  });
});
