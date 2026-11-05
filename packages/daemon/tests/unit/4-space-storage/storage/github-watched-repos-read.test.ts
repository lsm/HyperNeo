import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  GitHubEventExtensionRepository,
  type GitHubWatchedRepo,
} from '../../../../src/lib/external-events/github/github-repository';
import {
  createWatchedTable,
  insertWatchedRow,
  watchedRow,
  mappedWatchedRow,
} from '../../helpers/github-watched-read-fixture';

type Readers = {
  listGitHubWatchedRepos: (db: Database, spaceId?: string) => GitHubWatchedRepo[];
  mapGitHubWatchedRepo: (row: Record<string, unknown>) => GitHubWatchedRepo;
};
async function readers(): Promise<Readers> {
  const file = new URL(
    '../../../../src/storage/repositories/github-watched-repos-read.ts',
    import.meta.url
  );
  if (!existsSync(file))
    throw new Error('Constructor-free GitHub watched repository reads are unavailable');
  return import(file.href);
}
describe('GitHub watched repository read extraction', () => {
  let db: Database;
  let repo: GitHubEventExtensionRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE spaces(id TEXT PRIMARY KEY)');
    createWatchedTable(db);
    repo = new GitHubEventExtensionRepository(db);
    insertWatchedRow(db);
    insertWatchedRow(db, { id: 'synthetic-two', owner: 'OwnerA', repo: 'repo-b' });
    insertWatchedRow(db, { id: 'synthetic-three', owner: 'OwnerA', repo: 'repo-a' });
    insertWatchedRow(db, {
      id: 'synthetic-other',
      space_id: 'another-space',
      owner: 'OwnerA',
      repo: 'repo-a',
    });
  });
  afterEach(() => db.close());
  test('legacy reads preserve every field, Space isolation, ordering and empty filter semantics', () => {
    expect(repo.getWatchedRepoById('synthetic-one')).toEqual(mappedWatchedRow);
    expect(repo.listWatchedRepos('synthetic-space').map((row) => row.id)).toEqual([
      'synthetic-three',
      'synthetic-two',
      'synthetic-one',
    ]);
    expect(repo.listWatchedRepos().map((row) => row.id)).toEqual([
      'synthetic-other',
      'synthetic-three',
      'synthetic-two',
      'synthetic-one',
    ]);
    expect(repo.listWatchedRepos('')).toEqual(repo.listWatchedRepos());
    expect(repo.listWatchedRepos('missing')).toEqual([]);
  });
  test('helpers preserve complete rows and ordering on query-only SQLite', async () => {
    const r = await readers();
    const before = db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all();
    db.exec('PRAGMA query_only=ON');
    expect(r.mapGitHubWatchedRepo(watchedRow)).toEqual(mappedWatchedRow);
    for (const space of [undefined, '', 'synthetic-space', 'another-space', 'missing'])
      expect(r.listGitHubWatchedRepos(db, space)).toEqual(repo.listWatchedRepos(space));
    expect(db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all()).toEqual(
      before
    );
    expect(repo.listPollingRepos('synthetic-space')).toEqual(
      r.listGitHubWatchedRepos(db, 'synthetic-space')
    );
  });
  test('mapper keeps nullable/default and strict flag semantics with no repository', async () => {
    const r = await readers();
    const minimal = r.mapGitHubWatchedRepo({
      id: 'minimal',
      space_id: 'missing-space',
      owner: 'owner',
      repo: 'repo',
      enabled: 2,
      webhook_enabled: '1',
      polling_enabled: -1,
      webhook_auto_registered: 2,
      webhook_active: undefined,
      poll_cursor: '',
      created_at: 0,
      updated_at: 0,
    });
    expect(minimal).toEqual({
      id: 'minimal',
      spaceId: 'missing-space',
      owner: 'owner',
      repo: 'repo',
      enabled: false,
      webhookEnabled: false,
      pollingEnabled: false,
      webhookSecret: null,
      webhookRemoteId: null,
      webhookUrl: null,
      webhookAutoRegistered: false,
      webhookActive: null,
      webhookLastCheckedAt: null,
      webhookLastError: null,
      webhookConfiguredAt: null,
      lastWebhookAt: null,
      lastPollAt: null,
      pollCursor: null,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(r.mapGitHubWatchedRepo({ ...watchedRow, webhook_active: 1 }).webhookActive).toBe(true);
    expect(r.mapGitHubWatchedRepo({ ...watchedRow, webhook_active: 2 }).webhookActive).toBe(false);
    expect(
      r.mapGitHubWatchedRepo({ ...watchedRow, webhook_active: null }).webhookActive
    ).toBeNull();
    expect(r.mapGitHubWatchedRepo({ ...watchedRow, poll_cursor: null }).pollCursor).toBeNull();
  });
  test('malformed cursor still rejects list and other repository read surfaces', async () => {
    const r = await readers();
    db.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run(
      '{broken',
      'synthetic-one'
    );
    expect(() => r.mapGitHubWatchedRepo({ ...watchedRow, poll_cursor: '{broken' })).toThrow(
      SyntaxError
    );
    expect(() => r.listGitHubWatchedRepos(db, 'synthetic-space')).toThrow(SyntaxError);
    expect(() => repo.listWatchedRepos('synthetic-space')).toThrow(SyntaxError);
    expect(() => repo.getWatchedRepoById('synthetic-one')).toThrow(SyntaxError);
    expect(() => repo.listPollingRepos('synthetic-space')).toThrow(SyntaxError);
  });
});
