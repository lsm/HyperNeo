import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { Database } from '../../../../src/storage/sqlite-compat';
import { GitHubEventExtensionRepository } from '../../../../src/lib/external-events/github/github-repository';

type Readers = {
  readGitHubSpaceEnabled: (db: Database, spaceId: string) => boolean;
  readGitHubPollingIntent: (db: Database, spaceId: string) => boolean;
  readGitHubFilterCurrentUser: (db: Database, spaceId: string) => boolean;
};
async function readers(): Promise<Readers> {
  const file = new URL(
    '../../../../src/storage/repositories/github-space-settings-read.ts',
    import.meta.url
  );
  if (!existsSync(file))
    throw new Error('Constructor-free GitHub Space settings reads are unavailable');
  return import(file.href);
}

describe('GitHub Space settings read extraction', () => {
  let db: Database;
  let repo: GitHubEventExtensionRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      'CREATE TABLE spaces(id TEXT PRIMARY KEY); CREATE TABLE space_github_watched_repos(space_id TEXT, polling_enabled INTEGER)'
    );
    repo = new GitHubEventExtensionRepository(db);
  });
  afterEach(() => db.close());
  const legacy = (key: string) => [
    repo.isSpaceEnabled(key),
    repo.getPollingIntent(key),
    repo.getFilterCurrentUser(key),
  ];
  const seed = (key: string, values: (number | null)[]) =>
    db
      .prepare(
        'INSERT INTO space_github_source_settings(space_id,enabled,polling_intent,filter_current_user,created_at,updated_at) VALUES(?,?,?,?,5,9)'
      )
      .run(key, ...values);
  test('legacy defaults and explicit flags remain isolated by Space', () => {
    expect(legacy('missing')).toEqual([true, false, true]);
    seed('synthetic-one', [0, 1, 0]);
    seed('synthetic-two', [1, 0, 1]);
    expect(legacy('synthetic-one')).toEqual([false, true, false]);
    expect(legacy('synthetic-two')).toEqual([true, false, true]);
    expect(legacy('missing')).toEqual([true, false, true]);
  });
  test('helpers match every legacy boolean combination using only reads', async () => {
    const r = await readers();
    const keys = ['missing'];
    for (let i = 0; i < 8; i++) {
      const key = `synthetic-${i}`;
      seed(key, [i & 1, (i >> 1) & 1, (i >> 2) & 1]);
      keys.push(key);
    }
    const before = db.prepare('SELECT * FROM space_github_source_settings ORDER BY space_id').all();
    db.exec('PRAGMA query_only=ON');
    for (const key of keys)
      expect([
        r.readGitHubSpaceEnabled(db, key),
        r.readGitHubPollingIntent(db, key),
        r.readGitHubFilterCurrentUser(db, key),
      ]).toEqual(legacy(key));
    expect(
      db.prepare('SELECT * FROM space_github_source_settings ORDER BY space_id').all()
    ).toEqual(before);
  });
  test('helpers retain strict equality for noncanonical stored flags without initialization', async () => {
    const r = await readers();
    const scratch = new Database(':memory:');
    try {
      scratch.exec(
        "CREATE TABLE space_github_source_settings(space_id TEXT PRIMARY KEY,enabled INTEGER,polling_intent INTEGER,filter_current_user INTEGER); INSERT INTO space_github_source_settings VALUES('synthetic-odd',2,-1,NULL),('synthetic-true',1,1,1); PRAGMA query_only=ON"
      );
      expect([
        r.readGitHubSpaceEnabled(scratch, 'synthetic-odd'),
        r.readGitHubPollingIntent(scratch, 'synthetic-odd'),
        r.readGitHubFilterCurrentUser(scratch, 'synthetic-odd'),
      ]).toEqual([false, false, false]);
      expect([
        r.readGitHubSpaceEnabled(scratch, 'synthetic-true'),
        r.readGitHubPollingIntent(scratch, 'synthetic-true'),
        r.readGitHubFilterCurrentUser(scratch, 'synthetic-true'),
      ]).toEqual([true, true, true]);
      expect([
        r.readGitHubSpaceEnabled(scratch, 'missing'),
        r.readGitHubPollingIntent(scratch, 'missing'),
        r.readGitHubFilterCurrentUser(scratch, 'missing'),
      ]).toEqual([true, false, true]);
    } finally {
      scratch.close();
    }
  });
  test('helper failures preserve the existing query error', async () => {
    const r = await readers();
    db.exec('DROP TABLE space_github_source_settings');
    const message = (read: () => unknown) => {
      try {
        read();
        throw new Error('query unexpectedly succeeded');
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(message(() => r.readGitHubSpaceEnabled(db, 'missing'))).toEqual(
      message(() => repo.isSpaceEnabled('missing'))
    );
    expect(message(() => r.readGitHubPollingIntent(db, 'missing'))).toEqual(
      message(() => repo.getPollingIntent('missing'))
    );
    expect(message(() => r.readGitHubFilterCurrentUser(db, 'missing'))).toEqual(
      message(() => repo.getFilterCurrentUser('missing'))
    );
  });
});
