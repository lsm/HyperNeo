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
  mappedWatchedRow,
} from '../../helpers/github-watched-read-fixture';

type Readers = {
  findGitHubWatchedRepo: (
    db: Database,
    spaceId: string,
    owner: string,
    repo: string
  ) => GitHubWatchedRepo | null;
  findGitHubWatchedRepoById: (db: Database, id: string) => GitHubWatchedRepo | null;
};
async function readers(): Promise<Readers> {
  const file = new URL(
    '../../../../src/storage/repositories/github-watched-repo-lookups.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Constructor-free GitHub watched lookups are unavailable');
  return import(file.href);
}
describe('GitHub watched repository lookup extraction', () => {
  let db: Database;
  let repo: GitHubEventExtensionRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE spaces(id TEXT PRIMARY KEY)');
    createWatchedTable(db);
    repo = new GitHubEventExtensionRepository(db);
    insertWatchedRow(db);
    insertWatchedRow(db, { id: 'synthetic-other', space_id: 'another-space' });
  });
  afterEach(() => db.close());
  test('legacy lookups preserve complete rows, case matching, Space isolation and missing results', () => {
    expect(repo.getWatchedRepo('synthetic-space', 'ownerz', 'REPO-Z')).toEqual(mappedWatchedRow);
    expect(repo.getWatchedRepo('another-space', 'OWNERZ', 'repo-z')?.id).toBe('synthetic-other');
    expect(repo.getWatchedRepo('SYNTHETIC-SPACE', 'ownerz', 'repo-z')).toBeNull();
    expect(repo.getWatchedRepo('synthetic-space', 'missing', 'repo-z')).toBeNull();
    expect(repo.getWatchedRepoById('synthetic-one')).toEqual(mappedWatchedRow);
    expect(repo.getWatchedRepoById('SYNTHETIC-ONE')).toBeNull();
  });
  test('helpers preserve exact mapped results and missing keys on query-only SQLite', async () => {
    const r = await readers();
    const before = db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all();
    db.exec('PRAGMA query_only=ON');
    for (const key of [
      ['synthetic-space', 'ownerz', 'REPO-Z'],
      ['another-space', 'OWNERZ', 'repo-z'],
      ['missing', 'OwnerZ', 'repo-z'],
      ['', '', ''],
    ] as const)
      expect(r.findGitHubWatchedRepo(db, key[0], key[1], key[2])).toEqual(
        repo.getWatchedRepo(key[0], key[1], key[2])
      );
    for (const id of ['synthetic-one', 'synthetic-other', 'SYNTHETIC-ONE', '', 'missing'])
      expect(r.findGitHubWatchedRepoById(db, id)).toEqual(repo.getWatchedRepoById(id));
    expect(db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all()).toEqual(
      before
    );
  });
  test('helpers need only a watched table and do not initialize or backfill unrelated settings', async () => {
    const r = await readers();
    const scratch = new Database(':memory:');
    try {
      createWatchedTable(scratch);
      insertWatchedRow(scratch);
      scratch.exec('PRAGMA query_only=ON');
      expect(r.findGitHubWatchedRepo(scratch, 'synthetic-space', 'OWNERZ', 'repo-z')).toEqual(
        mappedWatchedRow
      );
      expect(r.findGitHubWatchedRepoById(scratch, 'synthetic-one')).toEqual(mappedWatchedRow);
      expect(
        scratch
          .prepare("SELECT name FROM sqlite_master WHERE name='space_github_source_settings'")
          .get()
      ).toBeNull();
    } finally {
      scratch.close();
    }
  });
  test('malformed matching cursors still throw while missing keys stay null', async () => {
    const r = await readers();
    db.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run(
      '{broken',
      'synthetic-one'
    );
    expect(() => repo.getWatchedRepo('synthetic-space', 'ownerz', 'repo-z')).toThrow(SyntaxError);
    expect(() => r.findGitHubWatchedRepo(db, 'synthetic-space', 'ownerz', 'repo-z')).toThrow(
      SyntaxError
    );
    expect(() => r.findGitHubWatchedRepoById(db, 'synthetic-one')).toThrow(SyntaxError);
    expect(r.findGitHubWatchedRepoById(db, 'missing')).toBeNull();
    expect(r.findGitHubWatchedRepo(db, 'missing', 'ownerz', 'repo-z')).toBeNull();
  });
  test('helpers observe caller writes without committing or changing rollback ownership', async () => {
    const r = await readers();
    expect(() =>
      db.transaction(() => {
        db.prepare('UPDATE space_github_watched_repos SET webhook_last_error=? WHERE id=?').run(
          'synthetic-uncommitted',
          'synthetic-one'
        );
        expect(
          r.findGitHubWatchedRepo(db, 'synthetic-space', 'ownerz', 'repo-z')?.webhookLastError
        ).toBe('synthetic-uncommitted');
        expect(r.findGitHubWatchedRepoById(db, 'synthetic-one')?.webhookLastError).toBe(
          'synthetic-uncommitted'
        );
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(r.findGitHubWatchedRepoById(db, 'synthetic-one')).toEqual(mappedWatchedRow);
  });
});
