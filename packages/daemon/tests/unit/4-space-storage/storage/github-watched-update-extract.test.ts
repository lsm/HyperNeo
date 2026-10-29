import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
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
import {
  findGitHubWatchedRepo,
  findGitHubWatchedRepoById,
} from '../../../../src/storage/repositories/github-watched-repo-lookups';
import {
  listGitHubWatchedRepos,
  mapGitHubWatchedRepo,
} from '../../../../src/storage/repositories/github-watched-repos-read';
import {
  readGitHubSpaceEnabled,
  readGitHubPollingIntent,
  readGitHubFilterCurrentUser,
} from '../../../../src/storage/repositories/github-space-settings-read';
import { persistGitHubPollCursorJson } from '../../../../src/storage/repositories/github-cursor-persist';

type Params = Parameters<GitHubEventExtensionRepository['upsertWatchedRepo']>[0];
type Persist = (db: Database, params: Params, existing: GitHubWatchedRepo, now: number) => void;
const identity = { spaceId: 'synthetic-space', owner: 'ownerz', repo: 'REPO-Z' };
async function persistence(): Promise<Persist> {
  const file = new URL(
    '../../../../src/storage/repositories/github-watched-update-persist.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Constructor-free GitHub watched UPDATE is unavailable');
  return (await import(file.href)).persistGitHubWatchedRepoUpdate;
}
describe('GitHub watched repository UPDATE extraction', () => {
  let db: Database;
  let repo: GitHubEventExtensionRepository;
  const rows = (): Record<string, unknown>[] =>
    db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all() as Record<
      string,
      unknown
    >[];
  const seed = (overrides: Record<string, string | number | null> = {}) => {
    db.exec('DELETE FROM space_github_watched_repos');
    insertWatchedRow(db, overrides);
    insertWatchedRow(db, { id: 'synthetic-peer', space_id: 'another-space' });
  };
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE spaces(id TEXT PRIMARY KEY)');
    createWatchedTable(db);
    repo = new GitHubEventExtensionRepository(db);
    seed();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });
  test('audited stable module hashes and constructor-free interfaces stay pinned', () => {
    const hashes = {
      'github-watched-repo-lookups.ts':
        'efd6b45d927224ce17fb9d819a4c8d325dcde4cacf1e7c7e75ca7238b18d46c4',
      'github-watched-repos-read.ts':
        '4c5945ea131459249bb302cdb27ee6a014fc6aadd5d15f9d402b3226972e6a95',
      'github-space-settings-read.ts':
        '821cdbd20d30a954c0aa6c1c82ad8ff88e098abbd76e522e4072dce26d240681',
      'github-cursor-persist.ts':
        '8ec4673c7f96429b885da9367af90c023bf161668f49607c799ea845658d3bae',
    };
    for (const [name, sha] of Object.entries(hashes))
      expect(
        createHash('sha256')
          .update(
            readFileSync(new URL('../../../../src/storage/repositories/' + name, import.meta.url))
          )
          .digest('hex')
      ).toBe(sha);
    insertWatchedRow(db, { id: 'synthetic-first', owner: 'OwnerA', repo: 'repo-a' });
    db.exec('PRAGMA query_only=ON');
    expect(mapGitHubWatchedRepo(watchedRow)).toEqual(mappedWatchedRow);
    expect(findGitHubWatchedRepo(db, 'synthetic-space', 'ownerz', 'REPO-Z')).toEqual(
      mappedWatchedRow
    );
    expect(findGitHubWatchedRepoById(db, 'synthetic-one')).toEqual(mappedWatchedRow);
    expect(findGitHubWatchedRepo(db, 'SYNTHETIC-SPACE', 'ownerz', 'repo-z')).toBeNull();
    expect(findGitHubWatchedRepoById(db, 'missing')).toBeNull();
    expect(listGitHubWatchedRepos(db, 'synthetic-space').map((r) => r.id)).toEqual([
      'synthetic-first',
      'synthetic-one',
    ]);
    expect([
      readGitHubSpaceEnabled(db, 'missing'),
      readGitHubPollingIntent(db, 'missing'),
      readGitHubFilterCurrentUser(db, 'missing'),
    ]).toEqual([true, false, true]);
    db.exec('PRAGMA query_only=OFF');
    db.prepare(
      'INSERT INTO space_github_source_settings(space_id,enabled,polling_intent,filter_current_user,created_at,updated_at)VALUES(?,0,1,0,1,1)'
    ).run('synthetic-space');
    expect([
      readGitHubSpaceEnabled(db, 'synthetic-space'),
      readGitHubPollingIntent(db, 'synthetic-space'),
      readGitHubFilterCurrentUser(db, 'synthetic-space'),
    ]).toEqual([false, true, false]);
    const before = rows();
    vi.spyOn(Date, 'now').mockReturnValue(41);
    expect(() =>
      db.transaction(() => {
        expect(
          persistGitHubPollCursorJson(db, 'synthetic-one', { lastSeenAt: 99 })
        ).toBeUndefined();
        expect(findGitHubWatchedRepoById(db, 'synthetic-one')?.pollCursor).toEqual({
          lastSeenAt: 99,
        });
        throw new Error('synthetic cursor rollback');
      })()
    ).toThrow('synthetic cursor rollback');
    expect(rows()).toEqual(before);
    db.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run(
      '{broken',
      'synthetic-one'
    );
    expect(() => findGitHubWatchedRepoById(db, 'synthetic-one')).toThrow(SyntaxError);
  });
  test('legacy UPDATE preserves identity, COALESCE fields, creation/cursor and peer row', () => {
    const before = rows();
    vi.spyOn(Date, 'now').mockReturnValue(41);
    const result = repo.upsertWatchedRepo({
      ...identity,
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
    });
    expect(result.id).toBe('synthetic-one');
    expect(result.owner).toBe('OwnerZ');
    expect(result.repo).toBe('repo-z');
    expect(rows()).toEqual([
      {
        ...before[0],
        enabled: 0,
        webhook_enabled: 0,
        polling_enabled: 0,
        webhook_auto_registered: 0,
        webhook_active: null,
        webhook_last_error: null,
        updated_at: 41,
      },
      before[1],
    ]);
  });
  test('helper retains exact legacy UPDATE SQL/bindings and flag/null/empty-value matrix', async () => {
    const persist = await persistence(),
      prepare = db.prepare.bind(db);
    let capture: { sql: string; args: unknown[]; rows: Record<string, unknown>[] } | undefined;
    vi.spyOn(db, 'prepare').mockImplementation((...args) => {
      const statement = prepare(...args);
      if (!args[0].includes('webhook_secret = COALESCE')) return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...bindings: unknown[]) => {
            const result = Reflect.apply(value, target, bindings);
            if (key === 'run') capture = { sql: args[0], args: bindings, rows: rows() };
            return result;
          };
        },
      });
    });
    vi.spyOn(Date, 'now').mockReturnValue(41);
    const cases: Partial<Params>[] = [
      {},
      {
        enabled: false,
        webhookEnabled: false,
        pollingEnabled: false,
        webhookAutoRegistered: false,
        webhookActive: null,
        webhookSecret: null,
        webhookRemoteId: null,
        webhookUrl: null,
        webhookLastCheckedAt: null,
        webhookLastError: null,
        webhookConfiguredAt: null,
      },
      {
        enabled: true,
        webhookEnabled: true,
        pollingEnabled: true,
        webhookAutoRegistered: true,
        webhookActive: true,
        webhookSecret: '',
        webhookRemoteId: 0,
        webhookUrl: '',
        webhookLastCheckedAt: 0,
        webhookLastError: '',
        webhookConfiguredAt: 0,
      },
      { webhookActive: false, pollingEnabled: false },
    ];
    const states: Record<string, string | number | null>[] = [
      {},
      {
        enabled: 0,
        webhook_enabled: 0,
        polling_enabled: 0,
        webhook_auto_registered: 0,
        webhook_active: null,
      },
      { webhook_active: 1 },
    ];
    for (const state of states)
      for (const patch of cases) {
        seed(state);
        const params = { ...identity, ...patch };
        repo.upsertWatchedRepo(params);
        const legacy = capture!;
        seed(state);
        const existing = repo.getWatchedRepoById('synthetic-one')!;
        capture = undefined;
        expect(persist(db, params, existing, 41)).toBeUndefined();
        expect(capture).toEqual(legacy);
      }
  });
  test('helper preserves caller transaction rollback and id isolation', async () => {
    const persist = await persistence(),
      before = rows(),
      existing = repo.getWatchedRepoById('synthetic-one')!;
    expect(() =>
      db.transaction(() => {
        persist(db, { ...identity, enabled: false }, existing, 99);
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(rows()).toEqual(before);
    persist(db, { ...identity, enabled: false }, existing, 99);
    expect(rows()[1]).toEqual(before[1]);
    expect(rows()[0].id).toBe('synthetic-one');
    expect(rows()[0].created_at).toBe(17);
  });
  test('failed statement is attempted once with no partial data or replay', async () => {
    const persist = await persistence(),
      existing = repo.getWatchedRepoById('synthetic-one')!,
      before = rows(),
      prepare = db.prepare.bind(db);
    let attempts = 0;
    db.exec(
      "CREATE TRIGGER reject_update AFTER UPDATE ON space_github_watched_repos BEGIN SELECT RAISE(ABORT,'synthetic UPDATE rejected');END"
    );
    vi.spyOn(db, 'prepare').mockImplementation((...args) => {
      const statement = prepare(...args);
      if (!args[0].includes('webhook_secret = COALESCE')) return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...bindings: unknown[]) => {
            if (key === 'run') attempts++;
            return Reflect.apply(value, target, bindings);
          };
        },
      });
    });
    expect(() => persist(db, { ...identity, enabled: false }, existing, 99)).toThrow(
      'synthetic UPDATE rejected'
    );
    expect(attempts).toBe(1);
    expect(rows()).toEqual(before);
  });
  test('table-only helper uses supplied time without initialization, UUID or clock reads', async () => {
    const persist = await persistence(),
      scratch = new Database(':memory:');
    try {
      createWatchedTable(scratch);
      insertWatchedRow(scratch);
      vi.spyOn(Date, 'now').mockImplementation(() => {
        throw new Error('helper must use supplied time');
      });
      expect(
        persist(scratch, { ...identity, enabled: false }, mappedWatchedRow, 41)
      ).toBeUndefined();
      expect(
        scratch.prepare('SELECT updated_at FROM space_github_watched_repos').get()!.updated_at
      ).toBe(41);
      expect(
        scratch
          .prepare("SELECT name FROM sqlite_master WHERE name='space_github_source_settings'")
          .get()
      ).toBeNull();
      expect(
        persist(scratch, identity, { ...mappedWatchedRow, id: 'missing' }, 41)
      ).toBeUndefined();
    } finally {
      scratch.close();
    }
  });
});
