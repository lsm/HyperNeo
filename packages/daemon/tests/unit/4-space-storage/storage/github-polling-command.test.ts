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
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import type { SpaceExternalEventSourceConfig } from '../../../../src/lib/external-events/types';
const name = 'github.space.polling.write';
type Args = { spaceId: string; enabled: boolean };
type Receipt = { config: SpaceExternalEventSourceConfig };
async function operation(): Promise<DbOp<Args, Receipt>> {
  const file = new URL(
    '../../../../src/storage/repositories/github-polling-enabled-write.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Atomic GitHub polling writer is unavailable');
  return (await import(file.href)).gitHubPollingWrites;
}
describe('audited GitHub polling dependency interfaces', () => {
  let db: Database;
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
    new GitHubEventExtensionRepository(db);
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
});
class FaultGateway extends DbGateway {
  calls = 0;
  rejectNext = false;
  loseNext = false;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== name) return super.run(op, args);
    this.calls++;
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error('synthetic admission rejected');
    }
    const result = await super.run(op, args);
    if (this.loseNext) {
      this.loseNext = false;
      throw new Error('synthetic committed reply lost; outcome unknown');
    }
    return result;
  }
}
describe('atomic GitHub polling writer construction', () => {
  let db: Database, gateway: FaultGateway, store: ExternalEventExtensionConfigStore;
  const cursor = {
    lastSeenAt: 15,
    etags: { issues: 'synthetic-etag' },
    checkRunHeadLastSeenAt: { old: 3 },
    checkRunHeadPendingLastSeenAt: { old: 4 },
    endpointLastSeenAt: { check_runs: 5, issues: 6 },
    endpointPendingLastSeenAt: { check_runs: 7, pulls: 8 },
  };
  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(
      "PRAGMA foreign_keys=ON;CREATE TABLE spaces(id TEXT PRIMARY KEY);INSERT INTO spaces VALUES('synthetic-one'),('synthetic-two'),('synthetic-empty');CREATE TABLE space_github_source_settings(space_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,polling_intent INTEGER NOT NULL DEFAULT 0,filter_current_user INTEGER NOT NULL DEFAULT 1);INSERT INTO space_github_source_settings VALUES('synthetic-one',0,11,12,0,0),('synthetic-two',1,21,22,0,1)"
    );
    createWatchedTable(db);
    insertWatchedRow(db, {
      id: 'synthetic-one',
      space_id: 'synthetic-one',
      enabled: 1,
      polling_enabled: 0,
      webhook_enabled: 0,
      webhook_secret: null,
      poll_cursor: JSON.stringify(cursor),
    });
    insertWatchedRow(db, {
      id: 'synthetic-hook',
      space_id: 'synthetic-one',
      repo: 'repo-hook',
      polling_enabled: 0,
    });
    insertWatchedRow(db, {
      id: 'synthetic-disabled',
      space_id: 'synthetic-one',
      repo: 'repo-disabled',
      enabled: 0,
      polling_enabled: 0,
      webhook_enabled: 0,
      webhook_secret: null,
    });
    insertWatchedRow(db, { id: 'synthetic-peer', space_id: 'synthetic-two' });
    store = new ExternalEventExtensionConfigStore(db);
    await store.setSpaceConfig('synthetic-one', 'github', {
      spaceId: 'synthetic-one',
      source: 'github',
      enabled: false,
      settings: { baseline: true },
    });
    db.exec('UPDATE space_external_event_source_configs SET created_at=13,updated_at=14');
    gateway = new FaultGateway(':memory:', db);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await gateway.close();
    db.close();
  });
  const persist = async (enabled = true, spaceId = 'synthetic-one') =>
    gateway.run(await operation(), { spaceId, enabled });
  const state = () => ({
    source: db
      .prepare('SELECT * FROM space_github_source_settings ORDER BY space_id')
      .all() as Record<string, unknown>[],
    watched: db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all() as Record<
      string,
      unknown
    >[],
    config: db
      .prepare('SELECT * FROM space_external_event_source_configs ORDER BY space_id,source')
      .all() as Record<string, unknown>[],
  });
  const sourceRow = () =>
    db.prepare("SELECT * FROM space_github_source_settings WHERE space_id='synthetic-one'").get();
  test('registered command commits eligible flags, intent and exact sanitized config together', async () => {
    const op = await operation();
    expect(DB_OPS.get(name)).toBe(op);
    expect(op.mode).toBe('write');
    const before = state();
    vi.spyOn(Date, 'now').mockReturnValue(41);
    const receipt = await persist();
    expect(await store.getSpaceConfig('synthetic-one', 'github')).toEqual(receipt.config);
    expect(receipt.config).toMatchObject({
      enabled: false,
      settings: { pollingIntent: true, filterCurrentUser: false },
    });
    expect(receipt.config.settings.watchedRepos).toHaveLength(3);
    expect(JSON.stringify(receipt)).not.toContain('synthetic-webhook-only');
    expect(JSON.stringify(receipt)).not.toContain('synthetic-etag');
    expect(findGitHubWatchedRepoById(db, 'synthetic-one')).toMatchObject({
      enabled: true,
      pollingEnabled: true,
      createdAt: 17,
      lastPollAt: 14,
      lastWebhookAt: 13,
      updatedAt: 41,
    });
    expect(findGitHubWatchedRepoById(db, 'synthetic-one')?.pollCursor).toEqual({
      lastSeenAt: 15,
      etags: { issues: 'synthetic-etag' },
      checkRunPollingEnabledAt: 41,
      endpointLastSeenAt: { issues: 6 },
      endpointPendingLastSeenAt: { pulls: 8 },
    });
    expect(findGitHubWatchedRepoById(db, 'synthetic-disabled')).toMatchObject({
      enabled: false,
      pollingEnabled: true,
      pollCursor: mappedWatchedRow.pollCursor,
    });
    expect(state().watched.find((r) => r.id === 'synthetic-hook')).toEqual(
      before.watched.find((r) => r.id === 'synthetic-hook')
    );
    expect(sourceRow()).toMatchObject({
      enabled: 0,
      created_at: 11,
      updated_at: 41,
      polling_intent: 1,
      filter_current_user: 0,
    });
    expect(
      db.prepare('SELECT created_at,updated_at FROM space_external_event_source_configs').get()
    ).toEqual({ created_at: 13, updated_at: 41 });
    expect(state().source.filter((r) => r.space_id === 'synthetic-two')).toEqual(
      before.source.filter((r) => r.space_id === 'synthetic-two')
    );
    expect(state().watched.filter((r) => r.space_id === 'synthetic-two')).toEqual(
      before.watched.filter((r) => r.space_id === 'synthetic-two')
    );
    const disabled = await persist(false);
    expect(disabled.config).toMatchObject({
      settings: { pollingIntent: false, filterCurrentUser: false },
    });
    expect(await store.getSpaceConfig('synthetic-one', 'github')).toEqual(disabled.config);
    for (const row of listGitHubWatchedRepos(db, 'synthetic-one'))
      expect(row.pollingEnabled).toBe(false);
    expect(sourceRow()).toMatchObject({
      enabled: 0,
      created_at: 11,
      polling_intent: 0,
      filter_current_user: 0,
    });
  });
  test('empty Space inserts defaults without constructor backfill on other Spaces', async () => {
    await operation();
    const before = state();
    vi.spyOn(Date, 'now').mockReturnValue(71);
    expect(await persist(true, 'synthetic-empty')).toEqual({
      config: {
        spaceId: 'synthetic-empty',
        source: 'github',
        enabled: true,
        settings: { pollingIntent: true, filterCurrentUser: true, watchedRepos: [] },
      },
    });
    expect(
      db
        .prepare("SELECT * FROM space_github_source_settings WHERE space_id='synthetic-empty'")
        .get()
    ).toEqual({
      space_id: 'synthetic-empty',
      enabled: 1,
      created_at: 71,
      updated_at: 71,
      polling_intent: 1,
      filter_current_user: 1,
    });
    expect(state().watched).toEqual(before.watched);
    expect(state().source.filter((r) => r.space_id === 'synthetic-two')).toEqual(
      before.source.filter((r) => r.space_id === 'synthetic-two')
    );
    expect(sourceRow()).toMatchObject({ enabled: 0, updated_at: 12, polling_intent: 0 });
  });
  test('snapshot failure rolls back watched flags, cursor, intent and config', async () => {
    await operation();
    const before = state();
    db.exec(
      "CREATE TRIGGER reject_snapshot AFTER UPDATE ON space_external_event_source_configs BEGIN SELECT RAISE(ABORT,'synthetic snapshot failure');END"
    );
    await expect(persist()).rejects.toThrow('synthetic snapshot failure');
    expect(state()).toEqual(before);
  });
  test('cursor write failure rolls back the earlier watched update in the gateway transaction', async () => {
    await operation();
    const before = state();
    db.exec(
      "CREATE TRIGGER reject_cursor BEFORE UPDATE OF poll_cursor ON space_github_watched_repos WHEN NEW.id='synthetic-one' BEGIN SELECT RAISE(ABORT,'synthetic cursor failure');END"
    );
    await expect(persist()).rejects.toThrow('synthetic cursor failure');
    expect(state()).toEqual(before);
  });
  test('malformed cursor, orphan and invalid Space keys leave no partial writes', async () => {
    await operation();
    db.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run(
      '{broken',
      'synthetic-one'
    );
    const before = state();
    await expect(persist()).rejects.toThrow(SyntaxError);
    expect(state()).toEqual(before);
    await expect(persist(true, 'synthetic-missing')).rejects.toThrow(/FOREIGN KEY/i);
    for (const key of ['', ' ', ' synthetic-one', 'synthetic-one '])
      await expect(persist(true, key)).rejects.toThrow(
        'Space id must be non-empty and must not include edge whitespace'
      );
    expect(state()).toEqual(before);
  });
  test('admission rejection leaves all state untouched without replay', async () => {
    await operation();
    const before = state();
    gateway.rejectNext = true;
    await expect(persist()).rejects.toThrow('admission rejected');
    expect(state()).toEqual(before);
    expect(gateway.calls).toBe(1);
  });
  test('lost committed acknowledgement leaves the complete snapshot visible without replay', async () => {
    await operation();
    gateway.loseNext = true;
    await expect(persist()).rejects.toThrow('outcome unknown');
    expect(await store.getSpaceConfig('synthetic-one', 'github')).toMatchObject({
      enabled: false,
      settings: { pollingIntent: true, filterCurrentUser: false },
    });
    expect(findGitHubWatchedRepoById(db, 'synthetic-one')?.pollingEnabled).toBe(true);
    expect(sourceRow()).toMatchObject({ polling_intent: 1, enabled: 0, filter_current_user: 0 });
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.calls).toBe(1);
  });
});
