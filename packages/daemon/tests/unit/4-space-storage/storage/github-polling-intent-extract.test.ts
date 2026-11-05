import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import { GitHubEventExtensionRepository } from '../../../../src/lib/external-events/github/github-repository';

type Persist = (db: Database, spaceId: string, enabled: boolean, now: number) => void;
async function persistence(): Promise<Persist> {
  const file = new URL(
    '../../../../src/storage/repositories/github-polling-intent-persist.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('GitHub polling intent SQL helper is unavailable');
  return (await import(file.href)).persistGitHubPollingIntent;
}
describe('GitHub polling intent SQL extraction', () => {
  let db: Database, repo: GitHubEventExtensionRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      'CREATE TABLE spaces(id TEXT PRIMARY KEY);CREATE TABLE space_github_watched_repos(space_id TEXT,polling_enabled INTEGER)'
    );
    repo = new GitHubEventExtensionRepository(db);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });
  const rows = () =>
    db.prepare('SELECT * FROM space_github_source_settings ORDER BY space_id').all();
  test('legacy setter captures one clock and retains defaults and creation time', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(41);
    expect(repo.setPollingIntent('synthetic-one', false)).toBeUndefined();
    expect(clock).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([
      {
        space_id: 'synthetic-one',
        enabled: 1,
        created_at: 41,
        updated_at: 41,
        polling_intent: 0,
        filter_current_user: 1,
      },
    ]);
    db.prepare('UPDATE space_github_source_settings SET enabled=0,filter_current_user=0').run();
    clock.mockReturnValue(99);
    repo.setPollingIntent('synthetic-one', true);
    expect(rows()).toEqual([
      {
        space_id: 'synthetic-one',
        enabled: 0,
        created_at: 41,
        updated_at: 99,
        polling_intent: 1,
        filter_current_user: 0,
      },
    ]);
  });
  test('helper retains exact SQL, bindings and result without reading a clock', async () => {
    const persist = await persistence(),
      prepare = db.prepare.bind(db),
      captures: { sql: string; args: unknown[] }[] = [];
    vi.spyOn(db, 'prepare').mockImplementation((...args) => {
      const statement = prepare(...args);
      if (!args[0].includes('INSERT INTO space_github_source_settings')) return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...bindings: unknown[]) => {
            if (key === 'run') captures.push({ sql: args[0], args: bindings });
            return Reflect.apply(value, target, bindings);
          };
        },
      });
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(41);
    const beforeResult = repo.setPollingIntent('synthetic-one', false),
      before = rows();
    db.exec('DELETE FROM space_github_source_settings');
    clock.mockImplementation(() => {
      throw new Error('helper must use caller time');
    });
    clock.mockClear();
    expect(persist(db, 'synthetic-one', false, 41)).toBe(beforeResult);
    expect(rows()).toEqual(before);
    expect(clock).not.toHaveBeenCalled();
    expect(captures).toHaveLength(2);
    expect(captures[1]).toEqual(captures[0]);
    expect(captures[0].args).toEqual(['synthetic-one', 0, 41, 41]);
  });
  test('helper conflict changes only polling intent and update time, isolated by Space', async () => {
    const persist = await persistence();
    persist(db, 'synthetic-one', true, 41);
    persist(db, 'synthetic-two', false, 51);
    db.prepare(
      'UPDATE space_github_source_settings SET enabled=0,filter_current_user=0 WHERE space_id=?'
    ).run('synthetic-one');
    persist(db, 'synthetic-one', false, 99);
    expect(rows()).toEqual([
      {
        space_id: 'synthetic-one',
        enabled: 0,
        created_at: 41,
        updated_at: 99,
        polling_intent: 0,
        filter_current_user: 0,
      },
      {
        space_id: 'synthetic-two',
        enabled: 1,
        created_at: 51,
        updated_at: 51,
        polling_intent: 0,
        filter_current_user: 1,
      },
    ]);
  });
  test('helper retains caller rollback for insert and update', async () => {
    const persist = await persistence();
    persist(db, 'synthetic-one', true, 41);
    const before = rows();
    expect(() =>
      db.transaction(() => {
        persist(db, 'synthetic-one', false, 99);
        persist(db, 'synthetic-two', false, 99);
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(rows()).toEqual(before);
  });
  test('helper and legacy setter preserve the same failed-statement state', async () => {
    const persist = await persistence();
    repo.setPollingIntent('synthetic-one', true);
    const before = rows();
    db.exec(
      "CREATE TRIGGER reject_intent AFTER UPDATE ON space_github_source_settings BEGIN SELECT RAISE(ABORT,'synthetic intent rejected');END"
    );
    expect(() => repo.setPollingIntent('synthetic-one', false)).toThrow(
      'synthetic intent rejected'
    );
    expect(rows()).toEqual(before);
    expect(() => persist(db, 'synthetic-one', false, 99)).toThrow('synthetic intent rejected');
    expect(rows()).toEqual(before);
  });
});
