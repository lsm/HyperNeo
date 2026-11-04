import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github/github-event-extension';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { InProcessTransport, MessageHub } from '@hyperneo/shared';

const readName = 'github.polling.capability.read',
  writeName = 'github.space.polling.write';
class CapabilityGateway extends DbGateway {
  reads = 0;
  writes = 0;
  holdNext = false;
  failNext = false;
  release?: () => void;
  afterWrite?: () => void;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name === writeName) {
      this.writes++;
      const result = await super.run(op, args);
      this.afterWrite?.();
      return result;
    }
    if (op.name !== readName) return super.run(op, args);
    this.reads++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('synthetic capability reader unavailable');
    }
    const result = await super.run(op, args);
    if (this.holdNext) {
      this.holdNext = false;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return result;
  }
}
describe('GitHub capability callback reader wiring', () => {
  let db: Database,
    gateway: CapabilityGateway,
    store: ExternalEventExtensionConfigStore,
    extension: GitHubEventExtension;
  let client: MessageHub, left: InProcessTransport, right: InProcessTransport;
  const space = 'synthetic-capability-reader',
    notices: string[] = [],
    pending = new Set<Promise<unknown>>();
  let releaseConfig: (() => void) | undefined;
  beforeEach(async () => {
    db = new Database(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    db.prepare(
      'INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,?,?)'
    ).run(space, space, 'synthetic-workspace', space, 1, 1);
    gateway = new CapabilityGateway(':memory:', db);
    bindGateway(db, gateway);
    store = new ExternalEventExtensionConfigStore(db);
    await store.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { rpcConfig: true, polling: false, webhooks: false },
    });
    extension = new GitHubEventExtension(db, undefined, {
      getPollIntervalMs: () => 60_000,
      autoReconcileWebhooks: false,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: space,
      owner: 'synthetic-owner',
      repo: 'repo',
      pollingEnabled: false,
      webhookEnabled: false,
    });
    notices.length = 0;
    releaseConfig = undefined;
    const context = {
      publisher: {
        publish: async () => {
          throw new Error('Must not publish');
        },
      },
      config: store,
      onSourceConfigChanged(change: { kind: string }) {
        notices.push(change.kind);
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
    releaseConfig?.();
    await Promise.allSettled([...pending]);
    vi.restoreAllMocks();
    await extension.stop();
    await Promise.all([left.close(), right.close()]);
    await gateway.close();
    db.close();
  });
  const request = (enabled: boolean) => {
    const promise = client.request('space.github.setPollingEnabled', { spaceId: space, enabled });
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise)
    );
    return promise;
  };
  const polling = async () => (await store.getGlobalConfig('github')).capabilities.polling;
  test('public disable uses the registered reader instead of main repository checks', async () => {
    await request(true);
    vi.spyOn(extension.repo, 'listAllPollingConfiguredRepos').mockImplementation(() => {
      throw new Error('Configured read reached main');
    });
    vi.spyOn(extension.repo, 'countSpacesWithPollingIntent').mockImplementation(() => {
      throw new Error('Intent read reached main');
    });
    const list = extension.repo.listPollingRepos.bind(extension.repo);
    vi.spyOn(extension.repo, 'listPollingRepos').mockImplementation((scope) => {
      if (scope) throw new Error('Session read reached main');
      return list(scope);
    });
    expect(await request(false)).toEqual({ spaceId: space, pollingEnabled: false });
    expect(gateway.reads).toBe(1);
    expect(await polling()).toBe(false);
  });
  test('a reader failure preserves its known write and emits no callback notification or retry', async () => {
    await request(true);
    const before = notices.length,
      writes = gateway.writes;
    gateway.failNext = true;
    await expect(request(false)).rejects.toThrow('synthetic capability reader unavailable');
    expect(gateway.reads).toBe(1);
    expect(gateway.writes).toBe(writes + 1);
    expect(notices).toHaveLength(before);
    expect(await polling()).toBe(true);
    expect(extension.repo.getPollingIntent(space)).toBe(false);
  });
  test('an older unused reply cannot disable polling enabled by a newer request', async () => {
    await request(true);
    gateway.holdNext = true;
    const before = notices.length;
    const older = request(false);
    await vi.waitFor(() => expect(gateway.release).toBeTypeOf('function'));
    expect(notices).toHaveLength(before);
    expect(await polling()).toBe(true);
    await request(true);
    gateway.release!();
    await older;
    expect(await polling()).toBe(true);
    expect(extension.repo.getPollingIntent(space)).toBe(true);
  });
  test('an older enable config reply cannot overwrite a newer disable', async () => {
    const get = store.getGlobalConfig.bind(store);
    let holdNext = false;
    gateway.afterWrite = () => {
      gateway.afterWrite = undefined;
      holdNext = true;
    };
    vi.spyOn(store, 'getGlobalConfig').mockImplementation(async (source) => {
      const result = await get(source);
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => {
          releaseConfig = resolve;
        });
      }
      return result;
    });
    const older = request(true);
    await vi.waitFor(() => expect(releaseConfig).toBeTypeOf('function'));
    await request(false);
    releaseConfig!();
    await older;
    expect(await polling()).toBe(false);
    expect(extension.repo.getPollingIntent(space)).toBe(false);
  });
});
