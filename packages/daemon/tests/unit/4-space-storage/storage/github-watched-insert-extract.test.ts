import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import { GitHubEventExtensionRepository } from '../../../../src/lib/external-events/github/github-repository';
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

import { persistGitHubWatchedRepoUpdate } from '../../../../src/storage/repositories/github-watched-update-persist';
type Params = Parameters<GitHubEventExtensionRepository['upsertWatchedRepo']>[0];
type Persist = (
  db: Database,
  params: Params,
  id: string,
  spaceEnabled: boolean,
  now: number
) => void;
const identity = { spaceId: 'synthetic-space', owner: 'NewOwner', repo: 'new-repo' };
async function persistence(): Promise<Persist> {
  const file = new URL(
    '../../../../src/storage/repositories/github-watched-insert-persist.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Constructor-free GitHub watched INSERT is unavailable');
  return (await import(file.href)).persistGitHubWatchedRepoInsert;
}
describe('GitHub watched repository INSERT extraction', () => {
  let db: Database;
  let repo: GitHubEventExtensionRepository;
  const rows = (): Record<string, unknown>[] =>
    db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all() as Record<
      string,
      unknown
    >[];
  const seed = () => {
    db.exec('DELETE FROM space_github_watched_repos');
    insertWatchedRow(db);
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
      'github-watched-update-persist.ts':
        'c4a07d91b0c58eb2983c0c367c4e31b8943a8569ba48f6c2a9ccace218215e54',
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
    const updateBefore = rows();
    expect(() =>
      db.transaction(() => {
        persistGitHubWatchedRepoUpdate(
          db,
          { spaceId: 'synthetic-space', owner: 'ownerz', repo: 'REPO-Z', enabled: false },
          mappedWatchedRow,
          55
        );
        expect(findGitHubWatchedRepoById(db, 'synthetic-one')?.enabled).toBe(false);
        expect(findGitHubWatchedRepoById(db, 'synthetic-one')?.updatedAt).toBe(55);
        throw new Error('synthetic UPDATE rollback');
      })()
    ).toThrow('synthetic UPDATE rollback');
    expect(rows()).toEqual(updateBefore);
    db.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run(
      '{broken',
      'synthetic-one'
    );
    expect(() => findGitHubWatchedRepoById(db, 'synthetic-one')).toThrow(SyntaxError);
  });
  test('legacy INSERT retains caller UUID/time and Space-enabled fallback with defaults', () => {
    db.prepare(
      'INSERT INTO space_github_source_settings(space_id,enabled,polling_intent,filter_current_user,created_at,updated_at)VALUES(?,0,0,1,1,1)'
    ).run(identity.spaceId);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(41),
      before = rows();
    const created = repo.upsertWatchedRepo(identity);
    expect(typeof created.id).toBe('string');
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.enabled).toBe(false);
    expect(created.createdAt).toBe(41);
    expect(created.updatedAt).toBe(41);
    expect(created.webhookEnabled).toBe(true);
    expect(created.pollingEnabled).toBe(false);
    expect(created.pollCursor).toBeNull();
    expect(clock).toHaveBeenCalledTimes(1);
    expect(rows().filter((r) => r.id !== created.id)).toEqual(before);
    expect(
      db.prepare('SELECT * FROM space_github_watched_repos WHERE id=?').get(created.id)
    ).toEqual({
      id: created.id,
      space_id: identity.spaceId,
      owner: identity.owner,
      repo: identity.repo,
      enabled: 0,
      webhook_enabled: 1,
      polling_enabled: 0,
      webhook_secret: null,
      webhook_remote_id: null,
      webhook_url: null,
      webhook_auto_registered: 0,
      webhook_active: null,
      webhook_last_checked_at: null,
      webhook_last_error: null,
      webhook_configured_at: null,
      last_webhook_at: null,
      last_poll_at: null,
      poll_cursor: null,
      created_at: 41,
      updated_at: 41,
    });
  });
  test('helper preserves exact INSERT SQL/bindings and caller-resolved flag/null/default matrix', async () => {
    const persist = await persistence(),
      prepare = db.prepare.bind(db),
      captures: { sql: string; args: unknown[]; rows: Record<string, unknown>[] }[] = [];
    vi.spyOn(db, 'prepare').mockImplementation((...args) => {
      const statement = prepare(...args);
      if (!args[0].startsWith('INSERT INTO space_github_watched_repos\n')) return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...bindings: unknown[]) => {
            const result = Reflect.apply(value, target, bindings);
            if (key === 'run') captures.push({ sql: args[0], args: bindings, rows: rows() });
            return result;
          };
        },
      });
    });
    vi.spyOn(Date, 'now').mockReturnValue(41);
    const patches: Partial<Params>[] = [
      {},
      {
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
      },
      {
        enabled: true,
        webhookEnabled: true,
        pollingEnabled: true,
        webhookSecret: '',
        webhookRemoteId: 0,
        webhookUrl: '',
        webhookAutoRegistered: true,
        webhookActive: true,
        webhookLastCheckedAt: 0,
        webhookLastError: '',
        webhookConfiguredAt: 0,
      },
      { webhookActive: false, pollingEnabled: true },
    ];
    for (const sourceEnabled of [false, true]) {
      db.prepare('DELETE FROM space_github_source_settings').run();
      db.prepare(
        'INSERT INTO space_github_source_settings(space_id,enabled,polling_intent,filter_current_user,created_at,updated_at)VALUES(?,?,0,1,1,1)'
      ).run(identity.spaceId, sourceEnabled ? 1 : 0);
      for (const patch of patches) {
        seed();
        captures.length = 0;
        const params = { ...identity, ...patch };
        repo.upsertWatchedRepo(params);
        expect(captures).toHaveLength(1);
        const legacy = captures[0]!;
        const id = String(legacy.args[0]);
        seed();
        captures.length = 0;
        const resolved = params.enabled ?? repo.isSpaceEnabled(params.spaceId);
        expect(persist(db, params, id, resolved, 41)).toBeUndefined();
        expect(captures).toEqual([legacy]);
      }
    }
  });
  test('helper preserves caller rollback and existing peer rows', async () => {
    const persist = await persistence(),
      before = rows();
    expect(() =>
      db.transaction(() => {
        persist(db, identity, 'synthetic-supplied', true, 41);
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(rows()).toEqual(before);
    persist(db, identity, 'synthetic-supplied', false, 41);
    expect(rows().filter((r) => r.id !== 'synthetic-supplied')).toEqual(before);
  });
  test('statement failure or duplicate supplied UUID is attempted once without replay', async () => {
    const persist = await persistence(),
      before = rows(),
      prepare = db.prepare.bind(db);
    let attempts = 0;
    vi.spyOn(db, 'prepare').mockImplementation((...args) => {
      const statement = prepare(...args);
      if (!args[0].startsWith('INSERT INTO space_github_watched_repos\n')) return statement;
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
    db.exec(
      "CREATE TRIGGER reject_insert AFTER INSERT ON space_github_watched_repos BEGIN SELECT RAISE(ABORT,'synthetic INSERT rejected');END"
    );
    expect(() => persist(db, identity, 'synthetic-supplied', true, 41)).toThrow(
      'synthetic INSERT rejected'
    );
    expect(attempts).toBe(1);
    expect(rows()).toEqual(before);
    db.exec('DROP TRIGGER reject_insert');
    expect(() => persist(db, identity, 'synthetic-one', true, 41)).toThrow(/UNIQUE/);
    expect(attempts).toBe(2);
    expect(rows()).toEqual(before);
  });
  test('table-only helper uses supplied id/time/Space decision without initialization or clock', async () => {
    const persist = await persistence(),
      scratch = new Database(':memory:');
    try {
      createWatchedTable(scratch);
      vi.spyOn(Date, 'now').mockImplementation(() => {
        throw new Error('helper must use caller time');
      });
      expect(
        persist(scratch, { ...identity, enabled: true }, 'synthetic-supplied', false, 41)
      ).toBeUndefined();
      expect(
        scratch
          .prepare('SELECT id,enabled,created_at,updated_at FROM space_github_watched_repos')
          .get()
      ).toEqual({ id: 'synthetic-supplied', enabled: 0, created_at: 41, updated_at: 41 });
      expect(
        scratch
          .prepare("SELECT name FROM sqlite_master WHERE name='space_github_source_settings'")
          .get()
      ).toBeNull();
    } finally {
      scratch.close();
    }
  });
});
