import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github/github-event-extension';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { InProcessTransport, MessageHub } from '@hyperneo/shared';

const opName = 'github.space.filter.write',
  spaceId = 'synthetic-filter-wire';
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
describe('GitHub filter RPC writer wiring', () => {
  let db: Database,
    gateway: ControlledGateway,
    store: ExternalEventExtensionConfigStore,
    extension: GitHubEventExtension;
  let client: MessageHub, left: InProcessTransport, right: InProcessTransport;
  let failNotify = false;
  const notices: { kind: string; filter: unknown; saved: unknown }[] = [];
  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    createTables(db);
    runMigrations(db, () => {});
    db.prepare(
      'INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,?,?)'
    ).run(spaceId, spaceId, 'synthetic-filter-workspace', 'Synthetic filter', 1, 1);
    gateway = new ControlledGateway(':memory:', db);
    bindGateway(db, gateway);
    store = new ExternalEventExtensionConfigStore(db);
    await store.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { rpcConfig: true, polling: false, webhooks: false },
    });
    extension = new GitHubEventExtension(db, undefined, {
      getPollIntervalMs: () => 0,
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
    extension.repo.setPollingIntent(spaceId, true);
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
            .prepare<{ filter_current_user: number }>(
              'SELECT filter_current_user FROM space_github_source_settings WHERE space_id=?'
            )
            .get(spaceId),
          saved = db
            .prepare<{ settings_json: string }>(
              'SELECT settings_json FROM space_external_event_source_configs WHERE space_id=? AND source=?'
            )
            .get(spaceId, 'github');
        notices.push({
          kind: change.kind,
          filter: source?.filter_current_user,
          saved: saved ? JSON.parse(saved.settings_json).filterCurrentUser : undefined,
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
    client.request<{ spaceId: string; filterCurrentUser: boolean }>(
      'space.github.setFilterCurrentUser',
      { spaceId, enabled }
    );
  const state = () => ({
    source: db.prepare('SELECT * FROM space_github_source_settings ORDER BY space_id').all(),
    watched: db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all(),
    config: db.prepare('SELECT * FROM space_external_event_source_configs ORDER BY space_id').all(),
  });
  test('ordinary reply and notification follow a consistent committed filter snapshot', async () => {
    const watched = state().watched;
    expect(await request(true)).toEqual({ spaceId, filterCurrentUser: true });
    expect(await store.getSpaceConfig(spaceId, 'github')).toMatchObject({
      enabled: false,
      settings: { filterCurrentUser: true, pollingIntent: true },
    });
    expect(notices).toEqual([{ kind: 'watched_repo_changed', filter: 1, saved: true }]);
    expect(await request(false)).toEqual({ spaceId, filterCurrentUser: false });
    expect(notices.at(-1)).toEqual({ kind: 'watched_repo_changed', filter: 0, saved: false });
    expect(state().watched).toEqual(watched);
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
    expect(notices).toEqual([{ kind: 'watched_repo_changed', filter: 1, saved: true }]);
  });
  test('admission rejection has no fallback, notification or replay', async () => {
    const before = state();
    gateway.rejectNext = true;
    await expect(request(true)).rejects.toThrow('admission rejected');
    expect(state()).toEqual(before);
    expect(notices).toEqual([]);
    expect(gateway.calls).toBe(1);
  });
  test('snapshot failure rolls back the filter before notification', async () => {
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
      settings: { filterCurrentUser: true },
    });
    expect(extension.repo.getFilterCurrentUser(spaceId)).toBe(true);
    expect(notices).toEqual([]);
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.calls).toBe(1);
  });
  test('known post-commit notification failure does not roll back or replay', async () => {
    failNotify = true;
    await expect(request(true)).rejects.toThrow('synthetic notification failure');
    expect(await store.getSpaceConfig(spaceId, 'github')).toMatchObject({
      enabled: false,
      settings: { filterCurrentUser: true },
    });
    expect(notices).toEqual([{ kind: 'watched_repo_changed', filter: 1, saved: true }]);
    expect(gateway.calls).toBe(1);
  });
  test('older receipt after a newer filter commit only notifies and never overwrites it', async () => {
    gateway.afterCommit = async () => {
      gateway.afterCommit = undefined;
      expect(await request(false)).toEqual({ spaceId, filterCurrentUser: false });
    };
    expect(await request(true)).toEqual({ spaceId, filterCurrentUser: true });
    expect(extension.repo.getFilterCurrentUser(spaceId)).toBe(false);
    expect(await store.getSpaceConfig(spaceId, 'github')).toMatchObject({
      settings: { filterCurrentUser: false },
    });
    expect(notices).toEqual([
      { kind: 'watched_repo_changed', filter: 0, saved: false },
      { kind: 'watched_repo_changed', filter: 0, saved: false },
    ]);
    expect(gateway.calls).toBe(2);
  });
  test('invalid parameters and authorization fail before admission', async () => {
    const before = state();
    for (const data of [{ spaceId }, { spaceId, enabled: 'true' }, { enabled: false }])
      await expect(client.request('space.github.setFilterCurrentUser', data)).rejects.toThrow(
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
});
