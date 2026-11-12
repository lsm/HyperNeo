import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github/github-event-extension';
import type { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { InProcessTransport, MessageHub } from '@hyperneo/shared';
import { createExternalEventConfigStore } from '../../helpers/external-event-config-store';

const opName = 'github.space.polling.write',
  spaceId = 'synthetic-polling-wire';
class ControlledGateway extends DbGateway {
  calls = 0;
  afterCommit?: () => Promise<void>;
  rejectNext = false;
  loseNext = false;
  hold?: Promise<void>;
  release?: () => void;
  pause() {
    this.hold = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== opName) return super.run(op, args);
    this.calls++;
    if (this.hold) await this.hold;
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error('synthetic writer admission rejected');
    }
    const result = await super.run(op, args);
    await this.afterCommit?.();
    if (this.loseNext) {
      this.loseNext = false;
      throw new Error('synthetic committed reply lost; outcome unknown');
    }
    return result;
  }
}
describe('GitHub polling RPC writer wiring', () => {
  let db: Database,
    gateway: ControlledGateway,
    store: ExternalEventExtensionConfigStore,
    extension: GitHubEventExtension;
  let client: MessageHub, left: InProcessTransport, right: InProcessTransport;
  let failNotify = false;
  let intervalMs = 60_000;
  const notices: { kind: string; intent: unknown; saved: unknown }[] = [];
  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    createTables(db);
    runMigrations(db, () => {});
    db.prepare(
      'INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,?,?)'
    ).run(spaceId, spaceId, 'synthetic-polling-workspace', 'Synthetic polling', 1, 1);
    gateway = new ControlledGateway(':memory:', db);
    bindGateway(db, gateway);
    store = createExternalEventConfigStore(db);
    await store.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { rpcConfig: true, polling: false, webhooks: false },
    });
    intervalMs = 60_000;
    extension = new GitHubEventExtension(db, undefined, {
      getPollIntervalMs: () => intervalMs,
      autoReconcileWebhooks: false,
    });
    extension.repo.upsertWatchedRepo({
      spaceId,
      owner: 'synthetic-owner',
      repo: 'repo',
      enabled: false,
      pollingEnabled: false,
      webhookEnabled: false,
    });
    extension.repo.setRepoEnabled(spaceId, false);
    extension.repo.upsertWatchedRepo({
      spaceId,
      owner: 'synthetic-owner',
      repo: 'repo',
      enabled: true,
      pollingEnabled: false,
    });
    extension.repo.setPollingIntent(spaceId, false);
    extension.repo.setFilterCurrentUser(spaceId, false);
    await store.setSpaceConfig(spaceId, 'github', {
      spaceId,
      source: 'github',
      enabled: false,
      settings: { baseline: true },
    });
    notices.length = 0;
    failNotify = false;
    const context = {
      publisher: {
        publish: async () => {
          throw new Error('Filter RPC must not publish');
        },
      },
      config: store,
      onSourceConfigChanged(change: { kind: string }) {
        const source = db
            .prepare<{ polling_intent: number }>(
              'SELECT polling_intent FROM space_github_source_settings WHERE space_id=?'
            )
            .get(spaceId),
          saved = db
            .prepare<{ settings_json: string }>(
              'SELECT settings_json FROM space_external_event_source_configs WHERE space_id=? AND source=?'
            )
            .get(spaceId, 'github');
        notices.push({
          kind: change.kind,
          intent: source?.polling_intent,
          saved: saved ? JSON.parse(saved.settings_json).pollingIntent : undefined,
        });
        if (failNotify) throw new Error('synthetic notification failure');
      },
    };
    await extension.start(context);
    client = new MessageHub();
    const server = new MessageHub();
    [left, right] = InProcessTransport.createPair();
    client.registerTransport(left);
    server.registerTransport(right);
    await Promise.all([left.initialize(), right.initialize()]);
    extension.registerRpcHandlers(server, context);
  });
  afterEach(async () => {
    gateway.release?.();
    vi.restoreAllMocks();
    await extension.stop();
    await Promise.all([left.close(), right.close()]);
    await gateway.close();
    db.close();
  });
  const request = (enabled: boolean) =>
    client.request<{ spaceId: string; pollingEnabled: boolean }>('space.github.setPollingEnabled', {
      spaceId,
      enabled,
    });
  const state = () => ({
    source: db.prepare('SELECT * FROM space_github_source_settings ORDER BY space_id').all(),
    watched: db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all(),
    config: db.prepare('SELECT * FROM space_external_event_source_configs ORDER BY space_id').all(),
  });
  test('seven full-file data pins retain the registered atomic writer interface', () => {
    const hashes = {
      'storage/repositories/github-watched-repo-lookups.ts':
        'ed10d2284643624e608b22eff1c17f50c0848c567681b41d11ff7f0345c438df',
      'storage/repositories/github-watched-repos-read.ts':
        'f41326de1acc9416d313230f3144405d21638e8c6d846149431558a26f883165',
      'storage/repositories/github-space-settings-read.ts':
        'b81f7c1ec84794b804f5308cc3a0c90306e3c60405fdddfd0dde70111a751752',
      'storage/repositories/github-cursor-persist.ts':
        'fcef214c6ba43ee94d34e8ed44fcaa913ab0bf9761fd61404b4328eab70744f4',
      'storage/repositories/github-watched-update-persist.ts':
        '193d6426e2c4bc6e70449a6ca53f75b2a18375a1f07d12215816617978f4b5c4',
      'storage/repositories/github-watched-upsert-persist.ts':
        'c108d5f4cff7893041110ad4c28154c7922b8a6204388a68ab7ab9a0cf5addd9',
      'storage/repositories/github-polling-enabled-write.ts':
        '35ea83f321ef4b0d1dc211a079fd10422dc6407b557e8f40f369b600cb99a75a',
    };
    for (const [file, sha] of Object.entries(hashes))
      expect(
        createHash('sha256')
          .update(readFileSync(new URL('../../../../src/' + file, import.meta.url)))
          .digest('hex')
      ).toBe(sha);
    expect(DB_OPS.get(opName)?.mode).toBe('write');
  });
  test('the approved fresh boundary and unchanged interface roots remain explicit', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'github-polling-boundary-'));
    try {
      const output = join(temporary, 'boundary.json');
      execFileSync(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-github-polling-wiring-measure.cjs',
              import.meta.url
            )
          ),
          output,
        ],
        { cwd: fileURLToPath(new URL('../../../../../..', import.meta.url)), stdio: 'pipe' }
      );
      const measured = JSON.parse(readFileSync(output, 'utf8'));
      expect(measured).toMatchObject({
        phase: 'wired',
        fresh: 167,
        dataExcluded: 282,
        ownedKnown: 449,
        interfaceLines: 67,
      });
      expect(measured.data).toHaveLength(7);
      expect(measured.interfaces).toHaveLength(11);
      expect(
        measured.interfaces.every(
          (row: { pinnedNotAudited: boolean; hashVerified: boolean }) =>
            row.pinnedNotAudited && row.hashVerified
        )
      ).toBe(true);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
  test('ordinary reply and notification follow a consistent committed polling snapshot', async () => {
    const watched = state().watched;
    expect(await request(true)).toEqual({ spaceId, pollingEnabled: true });
    expect(await store.getSpaceConfig(spaceId, 'github')).toMatchObject({
      enabled: false,
      settings: { filterCurrentUser: false, pollingIntent: true },
    });
    expect(notices).toEqual([{ kind: 'watched_repo_changed', intent: 1, saved: true }]);
    expect(await request(false)).toEqual({ spaceId, pollingEnabled: false });
    expect(notices.at(-1)).toEqual({ kind: 'watched_repo_changed', intent: 0, saved: false });
    expect(state().watched).toHaveLength(watched.length);
    expect(extension.repo.listWatchedRepos(spaceId).every((row) => !row.pollingEnabled)).toBe(true);
    expect(gateway.calls).toBe(2);
  });
  test('held writer leaves old configuration and notification pending until commit', async () => {
    const before = state();
    gateway.pause();
    let settled = false;
    const pending = request(true).finally(() => {
      settled = true;
    });
    try {
      await new Promise((done) => setTimeout(done, 10));
      expect(settled).toBe(false);
      expect(state()).toEqual(before);
      expect(notices).toEqual([]);
      expect(gateway.calls).toBe(1);
    } finally {
      gateway.release?.();
      await pending.catch(() => {});
    }
    expect(notices).toEqual([{ kind: 'watched_repo_changed', intent: 1, saved: true }]);
  });
  test('admission rejection has no fallback, notification or replay', async () => {
    const before = state();
    gateway.rejectNext = true;
    await expect(request(true)).rejects.toThrow('admission rejected');
    expect(state()).toEqual(before);
    expect(notices).toEqual([]);
    expect(gateway.calls).toBe(1);
  });
  test('snapshot failure rolls back flags and intent before notification', async () => {
    const before = state();
    db.exec(
      "CREATE TRIGGER reject_filter_snapshot AFTER UPDATE ON space_external_event_source_configs BEGIN SELECT RAISE(ABORT,'synthetic snapshot rejected');END"
    );
    await expect(request(true)).rejects.toThrow('synthetic snapshot rejected');
    expect(state()).toEqual(before);
    expect(notices).toEqual([]);
  });
  test('lost committed reply leaves a consistent snapshot without notification or replay', async () => {
    gateway.loseNext = true;
    await expect(request(true)).rejects.toThrow('outcome unknown');
    expect(await store.getSpaceConfig(spaceId, 'github')).toMatchObject({
      enabled: false,
      settings: { filterCurrentUser: false, pollingIntent: true },
    });
    expect(extension.repo.getPollingIntent(spaceId)).toBe(true);
    expect(notices).toEqual([]);
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.calls).toBe(1);
  });
  test('known post-commit notification failure does not roll back or replay', async () => {
    failNotify = true;
    await expect(request(true)).rejects.toThrow('synthetic notification failure');
    expect(await store.getSpaceConfig(spaceId, 'github')).toMatchObject({
      enabled: false,
      settings: { filterCurrentUser: false, pollingIntent: true },
    });
    expect(notices).toEqual([{ kind: 'watched_repo_changed', intent: 1, saved: true }]);
    expect(gateway.calls).toBe(1);
  });
  test('older receipt after a newer polling commit only notifies and never overwrites it', async () => {
    gateway.afterCommit = async () => {
      gateway.afterCommit = undefined;
      expect(await request(false)).toEqual({ spaceId, pollingEnabled: false });
    };
    expect(await request(true)).toEqual({ spaceId, pollingEnabled: true });
    expect(extension.repo.getPollingIntent(spaceId)).toBe(false);
    expect(await store.getSpaceConfig(spaceId, 'github')).toMatchObject({
      settings: { filterCurrentUser: false, pollingIntent: false },
    });
    expect(notices).toEqual([
      { kind: 'watched_repo_changed', intent: 0, saved: false },
      { kind: 'watched_repo_changed', intent: 0, saved: false },
    ]);
    expect(gateway.calls).toBe(2);
  });
  test('invalid parameters and authorization fail before admission', async () => {
    const before = state();
    for (const data of [{ spaceId }, { spaceId, enabled: 'true' }, { enabled: false }])
      await expect(client.request('space.github.setPollingEnabled', data)).rejects.toThrow(
        'spaceId and enabled are required'
      );
    await store.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { rpcConfig: false, polling: false, webhooks: false },
    });
    await expect(request(true)).rejects.toThrow('RPC configuration capability is disabled');
    expect(state()).toEqual(before);
    expect(gateway.calls).toBe(0);
    expect(notices).toEqual([]);
  });
  test('disabled interval rejects enabling before admission but still allows disabling', async () => {
    intervalMs = 0;
    const before = state();
    await expect(request(true)).rejects.toThrow('GitHub polling is disabled globally');
    expect(gateway.calls).toBe(0);
    expect(state()).toEqual(before);
    expect(await request(false)).toEqual({ spaceId, pollingEnabled: false });
    expect(gateway.calls).toBe(1);
  });
});
