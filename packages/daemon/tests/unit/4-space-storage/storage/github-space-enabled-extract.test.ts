import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import { GitHubEventExtensionRepository } from '../../../../src/lib/external-events/github/github-repository';

type Persist = (db: Database, spaceId: string, enabled: boolean, now: number) => number;
async function persistence(): Promise<Persist> {
  const file = new URL(
    '../../../../src/storage/repositories/github-space-enabled-persist.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('GitHub Space enabled SQL helper is unavailable');
  return (await import(file.href)).persistGitHubSpaceEnabled;
}
describe('GitHub Space enabled SQL extraction', () => {
  let db: Database;
  let repo: GitHubEventExtensionRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      'CREATE TABLE spaces(id TEXT PRIMARY KEY);CREATE TABLE space_github_watched_repos(id TEXT PRIMARY KEY,space_id TEXT,enabled INTEGER,updated_at INTEGER,polling_enabled INTEGER DEFAULT 0)'
    );
    repo = new GitHubEventExtensionRepository(db);
    db.exec(
      "INSERT INTO space_github_watched_repos(id,space_id,enabled,updated_at)VALUES('one','synthetic-one',1,5),('two','synthetic-one',1,5),('other','synthetic-two',1,5)"
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });
  const settings = () =>
    db.prepare('SELECT * FROM space_github_source_settings WHERE space_id=?').get('synthetic-one');
  const watched = () =>
    db
      .prepare('SELECT id,space_id,enabled,updated_at FROM space_github_watched_repos ORDER BY id')
      .all();
  test('legacy method retains one clock, changed-row count, creation time and Space isolation', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(41);
    expect(repo.setRepoEnabled('synthetic-one', false)).toBe(2);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(settings()).toEqual({
      space_id: 'synthetic-one',
      enabled: 0,
      created_at: 41,
      updated_at: 41,
      polling_intent: 0,
      filter_current_user: 1,
    });
    expect(watched()).toEqual([
      { id: 'one', space_id: 'synthetic-one', enabled: 0, updated_at: 41 },
      { id: 'other', space_id: 'synthetic-two', enabled: 1, updated_at: 5 },
      { id: 'two', space_id: 'synthetic-one', enabled: 0, updated_at: 41 },
    ]);
    clock.mockReturnValue(99);
    expect(repo.setRepoEnabled('synthetic-one', false)).toBe(2);
    expect(settings()).toMatchObject({ created_at: 41, updated_at: 99 });
  });
  test('legacy empty Space still stores its setting and returns zero changed watched rows', () => {
    vi.spyOn(Date, 'now').mockReturnValue(41);
    expect(repo.setRepoEnabled('synthetic-empty', false)).toBe(0);
    expect(repo.isSpaceEnabled('synthetic-empty')).toBe(false);
    expect(watched()).toHaveLength(3);
  });
  test('helper keeps both statements, bindings, rows and numeric result without a clock', async () => {
    const persist = await persistence(),
      captures: unknown[][] = [],
      prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((...args) => {
      const statement = prepare(...args);
      if (
        !/INSERT INTO space_github_source_settings|UPDATE space_github_watched_repos SET enabled/.test(
          args[0]
        )
      )
        return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...bindings: unknown[]) => {
            if (key === 'run') captures.push(bindings);
            return Reflect.apply(value, target, bindings);
          };
        },
      });
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(41);
    expect(repo.setRepoEnabled('synthetic-one', false)).toBe(2);
    const before = { settings: settings(), watched: watched() };
    db.exec(
      'DELETE FROM space_github_source_settings;UPDATE space_github_watched_repos SET enabled=1,updated_at=5'
    );
    clock.mockImplementation(() => {
      throw new Error('helper must use caller time');
    });
    clock.mockClear();
    expect(persist(db, 'synthetic-one', false, 41)).toBe(2);
    expect(clock).not.toHaveBeenCalled();
    expect({ settings: settings(), watched: watched() }).toEqual(before);
    expect(captures).toEqual([
      ['synthetic-one', 0, 41, 41],
      [0, 41, 'synthetic-one'],
      ['synthetic-one', 0, 41, 41],
      [0, 41, 'synthetic-one'],
    ]);
  });
  test('helper preserves caller-owned rollback across both statements', async () => {
    const persist = await persistence(),
      before = watched();
    expect(() =>
      db.transaction(() => {
        persist(db, 'synthetic-one', false, 41);
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(settings()).toBeNull();
    expect(watched()).toEqual(before);
  });
  test('helper retains legacy partial failure when caller supplies no transaction', async () => {
    const persist = await persistence();
    vi.spyOn(Date, 'now').mockReturnValue(99);
    db.exec(
      "CREATE TRIGGER reject_synthetic_watched AFTER UPDATE ON space_github_watched_repos WHEN NEW.updated_at=99 BEGIN SELECT RAISE(ABORT,'synthetic watched-row failure');END"
    );
    expect(() => repo.setRepoEnabled('synthetic-one', false)).toThrow(
      'synthetic watched-row failure'
    );
    const legacy = { settings: settings(), watched: watched() };
    expect(legacy.settings).toMatchObject({ enabled: 0, updated_at: 99 });
    db.exec('DELETE FROM space_github_source_settings');
    expect(() => persist(db, 'synthetic-one', false, 99)).toThrow('synthetic watched-row failure');
    expect({ settings: settings(), watched: watched() }).toEqual(legacy);
  });
});
