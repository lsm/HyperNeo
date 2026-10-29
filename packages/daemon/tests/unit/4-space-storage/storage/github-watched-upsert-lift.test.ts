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
type Receipt = ReturnType<GitHubEventExtensionRepository['upsertWatchedRepo']>;
type Persist = (db: Database, params: Params) => Receipt;
const identity = { spaceId: 'synthetic-space', owner: 'NewOwner', repo: 'new-repo' };
async function persistence(): Promise<Persist> {
  const file = new URL(
    '../../../../src/storage/repositories/github-watched-upsert-persist.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Constructor-free GitHub watched UPSERT is unavailable');
  return (await import(file.href)).upsertGitHubWatchedRepo;
}
describe('GitHub watched repository UPSERT extraction', () => {
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
  const cursor = {
    lastSeenAt: 15,
    etags: { issues: 'synthetic-etag' },
    checkRunHeadLastSeenAt: { old: 3 },
    checkRunHeadPendingLastSeenAt: { old: 4 },
    endpointLastSeenAt: { check_runs: 5, issues: 6 },
    endpointPendingLastSeenAt: { check_runs: 7, pulls: 8 },
  };
  const inactive = () =>
    db
      .prepare(
        'UPDATE space_github_watched_repos SET enabled=0,polling_enabled=0,poll_cursor=? WHERE id=?'
      )
      .run(JSON.stringify(cursor), 'synthetic-one');
  const existingIdentity = { spaceId: 'synthetic-space', owner: 'ownerz', repo: 'REPO-Z' };
  test('legacy activation preserves identity, receipts, Space fallback and cursor cleanup', () => {
    inactive();
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(41)
      .mockReturnValueOnce(42)
      .mockReturnValue(99);
    const activated = repo.upsertWatchedRepo({
      ...existingIdentity,
      enabled: true,
      pollingEnabled: true,
      webhookSecret: null,
    });
    expect(activated).toMatchObject({
      id: 'synthetic-one',
      owner: 'OwnerZ',
      repo: 'repo-z',
      createdAt: 17,
      updatedAt: 42,
      lastWebhookAt: 13,
      lastPollAt: 14,
      webhookSecret: 'synthetic-webhook-only',
      pollCursor: {
        lastSeenAt: 15,
        etags: { issues: 'synthetic-etag' },
        checkRunPollingEnabledAt: 41,
        endpointLastSeenAt: { issues: 6 },
        endpointPendingLastSeenAt: { pulls: 8 },
      },
    });
    expect(activated.pollCursor).toEqual({
      lastSeenAt: 15,
      etags: { issues: 'synthetic-etag' },
      checkRunPollingEnabledAt: 41,
      endpointLastSeenAt: { issues: 6 },
      endpointPendingLastSeenAt: { pulls: 8 },
    });
    expect(clock).toHaveBeenCalledTimes(2);
    expect(repo.upsertWatchedRepo(existingIdentity).pollCursor).toEqual(activated.pollCursor);
    db.prepare(
      'INSERT INTO space_github_source_settings(space_id,enabled,polling_intent,filter_current_user,created_at,updated_at)VALUES(?,0,0,1,1,1)'
    ).run(identity.spaceId);
    const created = repo.upsertWatchedRepo({ ...identity, pollingEnabled: true });
    expect(created.id).toMatch(/^[a-f0-9-]{36}$/i);
    expect(created).toMatchObject({
      enabled: false,
      pollingEnabled: true,
      createdAt: 99,
      updatedAt: 99,
      pollCursor: { checkRunPollingEnabledAt: 99 },
    });
  });
  test('constructor-free UPSERT matches legacy receipts and complete rows across flags and source fallback', async () => {
    const upsert = await persistence();
    vi.spyOn(Date, 'now').mockReturnValue(41);
    const patches: Partial<Params>[] = [
      {},
      { enabled: false },
      { pollingEnabled: false },
      { enabled: true, pollingEnabled: true },
      { enabled: false, pollingEnabled: true },
      { enabled: true, pollingEnabled: false },
      {
        webhookEnabled: false,
        webhookSecret: null,
        webhookRemoteId: 0,
        webhookUrl: '',
        webhookAutoRegistered: false,
        webhookActive: null,
        webhookLastCheckedAt: 0,
        webhookLastError: '',
        webhookConfiguredAt: 0,
      },
      { webhookActive: true, webhookSecret: 'synthetic-only' },
    ];
    for (const exists of [false, true])
      for (const sourceEnabled of [false, true])
        for (const active of [false, true])
          for (const patch of patches) {
            const params = { ...(exists ? existingIdentity : identity), ...patch };
            const setup = () => {
              seed();
              db.prepare(
                'UPDATE space_github_watched_repos SET enabled=?,polling_enabled=?,poll_cursor=? WHERE id=?'
              ).run(active ? 1 : 0, active ? 1 : 0, JSON.stringify(cursor), 'synthetic-one');
              db.prepare(
                'INSERT OR REPLACE INTO space_github_source_settings(space_id,enabled,polling_intent,filter_current_user,created_at,updated_at)VALUES(?,?,0,1,1,1)'
              ).run(identity.spaceId, sourceEnabled ? 1 : 0);
            };
            const snapshot = (receipt: Receipt) => {
              expect(receipt.id).toMatch(exists ? /^synthetic-one$/ : /^[a-f0-9-]{36}$/i);
              return {
                receipt: { ...receipt, id: exists ? receipt.id : 'generated-id' },
                rows: rows()
                  .map((row) => ({
                    ...row,
                    id: !exists && row.id === receipt.id ? 'generated-id' : row.id,
                  }))
                  .sort((a, b) => String(a.id).localeCompare(String(b.id))),
              };
            };
            setup();
            const expected = snapshot(repo.upsertWatchedRepo(params));
            setup();
            expect(snapshot(upsert(db, params))).toEqual(expected);
          }
  });
  test('table-only path updates and inserts without repository initialization or source-settings writes', async () => {
    const upsert = await persistence();
    db.exec('DROP TABLE space_github_source_settings');
    inactive();
    vi.spyOn(Date, 'now').mockReturnValue(41);
    const updated = upsert(db, { ...existingIdentity, enabled: true, pollingEnabled: true });
    expect(updated).toMatchObject({
      id: 'synthetic-one',
      createdAt: 17,
      updatedAt: 41,
      pollCursor: { checkRunPollingEnabledAt: 41 },
    });
    const created = upsert(db, { ...identity, enabled: false, pollingEnabled: true });
    expect(created).toMatchObject({
      enabled: false,
      pollingEnabled: true,
      pollCursor: null,
      createdAt: 41,
      updatedAt: 41,
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='space_github_source_settings'").get()
    ).toBeNull();
  });
  test('caller transaction rolls back the complete receipt and activation cursor', async () => {
    const upsert = await persistence();
    inactive();
    const before = rows();
    expect(() =>
      db.transaction(() => {
        const receipt = upsert(db, { ...existingIdentity, enabled: true, pollingEnabled: true });
        expect(receipt.pollCursor?.checkRunPollingEnabledAt).toBeGreaterThan(0);
        upsert(db, { ...identity, enabled: true, pollingEnabled: true });
        throw new Error('synthetic caller rollback');
      })()
    ).toThrow('synthetic caller rollback');
    expect(rows()).toEqual(before);
  });
  test('a failed write rejects once without replay or peer changes', async () => {
    const upsert = await persistence(),
      before = rows(),
      prepare = db.prepare.bind(db);
    let attempts = 0;
    vi.spyOn(db, 'prepare').mockImplementation((...args) => {
      const statement = prepare(...args);
      if (!args[0].startsWith('UPDATE space_github_watched_repos')) return statement;
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
      "CREATE TRIGGER reject_upsert BEFORE UPDATE ON space_github_watched_repos BEGIN SELECT RAISE(ABORT,'synthetic UPSERT rejected');END"
    );
    expect(() => upsert(db, { ...existingIdentity, enabled: false })).toThrow(
      'synthetic UPSERT rejected'
    );
    expect(attempts).toBe(1);
    expect(rows()).toEqual(before);
  });
  test('cursor failure retains legacy statement boundaries and respects caller rollback', async () => {
    const upsert = await persistence();
    for (const useHelper of [false, true])
      for (const transaction of [false, true]) {
        seed();
        inactive();
        const before = rows();
        db.exec(
          "CREATE TRIGGER reject_cursor BEFORE UPDATE OF poll_cursor ON space_github_watched_repos BEGIN SELECT RAISE(ABORT,'synthetic cursor rejected');END"
        );
        const call = () =>
          useHelper
            ? upsert(db, { ...existingIdentity, enabled: true, pollingEnabled: true })
            : repo.upsertWatchedRepo({ ...existingIdentity, enabled: true, pollingEnabled: true });
        expect(() => (transaction ? db.transaction(call)() : call())).toThrow(
          'synthetic cursor rejected'
        );
        if (transaction) expect(rows()).toEqual(before);
        else {
          expect(findGitHubWatchedRepoById(db, 'synthetic-one')).toMatchObject({
            enabled: true,
            pollingEnabled: true,
            pollCursor: cursor,
          });
          expect(rows().filter((r) => r.id !== 'synthetic-one')).toEqual(
            before.filter((r) => r.id !== 'synthetic-one')
          );
        }
        db.exec('DROP TRIGGER reject_cursor');
      }
  });
});
