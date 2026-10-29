import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github/github-event-extension';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { InProcessTransport, MessageHub } from '@hyperneo/shared';

const opName = 'github.space.enabled.write',
  spaceId = 'synthetic-wire-space';
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
describe('GitHub Space enable RPC writer wiring', () => {
  let db: Database,
    gateway: ControlledGateway,
    store: ExternalEventExtensionConfigStore,
    extension: GitHubEventExtension;
  let client: MessageHub, left: InProcessTransport, right: InProcessTransport;
  let interval: number;
  const notifications: { kind: string; sourceEnabled: unknown; configEnabled: unknown }[] = [];
  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    createTables(db);
    runMigrations(db, () => {});
    db.prepare(
      'INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,?,?)'
    ).run(spaceId, spaceId, 'synthetic-wire-workspace', 'Synthetic wire', 1, 1);
    gateway = new ControlledGateway(':memory:', db);
    bindGateway(db, gateway);
    store = new ExternalEventExtensionConfigStore(db);
    await store.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { rpcConfig: true, polling: false, webhooks: false },
    });
    interval = 60_000;
    extension = new GitHubEventExtension(db, undefined, {
      getPollIntervalMs: () => interval,
      autoReconcileWebhooks: false,
    });
    extension.repo.upsertWatchedRepo({
      spaceId,
      owner: 'synthetic-owner',
      repo: 'repo',
      enabled: false,
      pollingEnabled: true,
      webhookEnabled: false,
    });
    extension.repo.setRepoEnabled(spaceId, false);
    await store.setSpaceConfig(spaceId, 'github', {
      spaceId,
      source: 'github',
      enabled: false,
      settings: { baseline: true },
    });
    notifications.length = 0;
    const context = {
      publisher: {
        publish: async () => {
          throw new Error('Source enable wiring must not publish an event');
        },
      },
      config: store,
      onSourceConfigChanged(change: { kind: string }) {
        notifications.push({
          kind: change.kind,
          sourceEnabled: db
            .prepare<{ enabled: number }>(
              'SELECT enabled FROM space_github_source_settings WHERE space_id=?'
            )
            .get(spaceId)?.enabled,
          configEnabled: db
            .prepare<{ enabled: number }>(
              'SELECT enabled FROM space_external_event_source_configs WHERE space_id=? AND source=?'
            )
            .get(spaceId, 'github')?.enabled,
        });
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
    client.request(`space.github.${enabled ? 'enable' : 'disable'}`, { spaceId });
  const flags = () => ({
    source: db
      .prepare<{ enabled: number }>(
        'SELECT enabled FROM space_github_source_settings WHERE space_id=?'
      )
      .get(spaceId)?.enabled,
    config: db
      .prepare<{ enabled: number }>(
        'SELECT enabled FROM space_external_event_source_configs WHERE space_id=? AND source=?'
      )
      .get(spaceId, 'github')?.enabled,
    watched: db
      .prepare('SELECT enabled FROM space_github_watched_repos WHERE space_id=?')
      .all(spaceId),
  });
  test('ordinary replies and notifications observe one consistent committed snapshot', async () => {
    expect(await request(true)).toEqual({ spaceId, source: 'github', enabled: true });
    expect(flags()).toEqual({ source: 1, config: 1, watched: [{ enabled: 1 }] });
    expect((await store.getGlobalConfig('github')).capabilities.polling).toBe(true);
    expect(notifications).toEqual([{ kind: 'space_enabled', sourceEnabled: 1, configEnabled: 1 }]);
    expect(await request(false)).toEqual({ spaceId, source: 'github', enabled: false });
    expect(flags()).toEqual({ source: 0, config: 0, watched: [{ enabled: 0 }] });
    expect(notifications.at(-1)).toEqual({
      kind: 'space_disabled',
      sourceEnabled: 0,
      configEnabled: 0,
    });
    expect(gateway.calls).toBe(2);
  });
  test('writer admission holds flags, capability, notification and RPC reply until commit', async () => {
    gateway.pause();
    let settled = false;
    const pending = request(true).finally(() => {
      settled = true;
    });
    try {
      await new Promise((done) => setTimeout(done, 10));
      expect(settled).toBe(false);
      expect(gateway.calls).toBe(1);
      expect(flags()).toEqual({ source: 0, config: 0, watched: [{ enabled: 0 }] });
      expect((await store.getGlobalConfig('github')).capabilities.polling).toBe(false);
      expect(notifications).toEqual([]);
    } finally {
      gateway.release?.();
      await pending.catch(() => {});
    }
    expect(flags()).toEqual({ source: 1, config: 1, watched: [{ enabled: 1 }] });
    expect((await store.getGlobalConfig('github')).capabilities.polling).toBe(true);
    expect(notifications).toHaveLength(1);
  });
  test('superseded committed receipt cannot re-enable polling after a concurrent RPC disables it', async () => {
    const global = await store.getGlobalConfig('github');
    await store.setGlobalConfig('github', {
      ...global,
      capabilities: { ...global.capabilities, polling: true },
    });
    gateway.afterCommit = async () => {
      gateway.afterCommit = undefined;
      expect(
        await client.request<{ spaceId: string; pollingEnabled: boolean }>(
          'space.github.setPollingEnabled',
          { spaceId, enabled: false }
        )
      ).toEqual({ spaceId, pollingEnabled: false });
    };
    expect(await request(true)).toEqual({ spaceId, source: 'github', enabled: true });
    expect((await store.getGlobalConfig('github')).capabilities.polling).toBe(false);
    expect(extension.repo.listWatchedRepos(spaceId).every((row) => !row.pollingEnabled)).toBe(true);
    expect((await store.getSpaceConfig(spaceId, 'github'))?.settings.watchedRepos).toEqual(
      expect.arrayContaining([expect.objectContaining({ pollingEnabled: false })])
    );
    expect(notifications.map((notice) => notice.kind)).toEqual([
      'watched_repo_changed',
      'space_enabled',
    ]);
    expect(gateway.calls).toBe(1);
  });
  test('zero interval keeps polling capability disabled while enabling source configuration', async () => {
    interval = 0;
    expect(await request(true)).toEqual({ spaceId, source: 'github', enabled: true });
    expect((await store.getGlobalConfig('github')).capabilities.polling).toBe(false);
    expect(flags()).toEqual({ source: 1, config: 1, watched: [{ enabled: 1 }] });
    expect(gateway.calls).toBe(1);
  });
  test('snapshot SQL failure rolls back every flag and emits no notification', async () => {
    db.exec(
      "CREATE TRIGGER reject_wire_snapshot AFTER UPDATE ON space_external_event_source_configs BEGIN SELECT RAISE(ABORT,'synthetic snapshot rejected');END"
    );
    await expect(request(true)).rejects.toThrow('synthetic snapshot rejected');
    expect(flags()).toEqual({ source: 0, config: 0, watched: [{ enabled: 0 }] });
    expect(notifications).toEqual([]);
    expect((await store.getGlobalConfig('github')).capabilities.polling).toBe(false);
  });
  test('admission rejection never falls back or starts lifecycle work', async () => {
    gateway.rejectNext = true;
    await expect(request(true)).rejects.toThrow('admission rejected');
    expect(flags()).toEqual({ source: 0, config: 0, watched: [{ enabled: 0 }] });
    expect(notifications).toEqual([]);
    expect(gateway.calls).toBe(1);
    expect((await store.getGlobalConfig('github')).capabilities.polling).toBe(false);
  });
  test('lost committed reply leaves consistent data without lifecycle work or replay', async () => {
    gateway.loseNext = true;
    await expect(request(true)).rejects.toThrow('outcome unknown');
    expect(flags()).toEqual({ source: 1, config: 1, watched: [{ enabled: 1 }] });
    expect(notifications).toEqual([]);
    expect((await store.getGlobalConfig('github')).capabilities.polling).toBe(false);
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.calls).toBe(1);
  });
  test('known post-commit capability failure retains a consistent snapshot and does not notify', async () => {
    const original = store.setGlobalConfig.bind(store);
    vi.spyOn(store, 'setGlobalConfig').mockImplementation(async (source, config) => {
      if (config.capabilities.polling) throw new Error('synthetic polling capability failed');
      return original(source, config);
    });
    await expect(request(true)).rejects.toThrow('synthetic polling capability failed');
    expect(flags()).toEqual({ source: 1, config: 1, watched: [{ enabled: 1 }] });
    expect(notifications).toEqual([]);
    expect(gateway.calls).toBe(1);
  });
  test('authorization failure precedes writer admission', async () => {
    await store.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { rpcConfig: false, polling: false, webhooks: false },
    });
    await expect(request(true)).rejects.toThrow('RPC configuration capability is disabled');
    expect(gateway.calls).toBe(0);
    expect(flags()).toEqual({ source: 0, config: 0, watched: [{ enabled: 0 }] });
    expect(notifications).toEqual([]);
  });
});
