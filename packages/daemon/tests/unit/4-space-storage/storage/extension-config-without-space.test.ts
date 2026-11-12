import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store.ts';
import { GitHubEventExtensionRepository } from '../../../../src/lib/external-events/github/github-repository.ts';
import { runMigration128 } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createWatchedTable } from '../../helpers/github-watched-read-fixture.ts';

describe('external event config with Space tables absent', () => {
  let db: Database;
  const tables = () =>
    (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[])
      .map((row) => row.name)
      .sort();

  beforeEach(() => {
    db = new Database(':memory:');
    createWatchedTable(db);
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
    expect(tables()).toEqual(['github_session_watched_repos', 'space_github_watched_repos']);
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

  it('constructs no tables and leaves legacy rows unread for session scope', () => {
    db.prepare(
      `INSERT INTO space_github_watched_repos (id, space_id, polling_enabled) VALUES ('r', 'sessions', 1)`
    ).run();
    const repo = new GitHubEventExtensionRepository(db);
    expect(tables()).toEqual(['github_session_watched_repos', 'space_github_watched_repos']);
    expect(repo.listWatchedRepos()).toEqual([]);
    expect(repo.listWatchedRepos('sessions')).toEqual([]);
  });
});
