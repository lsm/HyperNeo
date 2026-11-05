import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github/github-event-extension';
import type { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { InProcessTransport, MessageHub } from '@hyperneo/shared';
import { createExternalEventConfigStore } from '../../helpers/external-event-config-store';

const readName = 'github.polling.capability.read',
  writeName = 'github.space.polling.write';
class CapabilityGateway extends DbGateway {
  reads = 0;
  writes = 0;
  holdNext = false;
  failNext = false;
  release?: () => void;
  afterWrite?: () => void;
  holdGlobal = false;
  releaseGlobal?: () => void;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name === 'extension.global.config.write' && this.holdGlobal) {
      this.holdGlobal = false;
      await new Promise<void>((resolve) => {
        this.releaseGlobal = resolve;
      });
    }
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
    store = createExternalEventConfigStore(db);
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
    gateway.releaseGlobal?.();
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
  test('counted activation and existing bounded config roots fit the cap without new exclusions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capability-measure-'));
    try {
      const output = join(dir, 'boundary.json');
      execFileSync(
        process.execPath,
        ['.claude/skills/verify/lane-c-github-capability-measure.cjs', output],
        { cwd: fileURLToPath(new URL('../../../../../../', import.meta.url)) }
      );
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        fresh: 178,
        bridgeLines: 10,
        smokeLines: 0,
        knownTotal: 188,
        excludedDataLines: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
    await request(true);
    expect(await polling()).toBe(true);
  });
  test('an older unused reply cannot disable polling enabled by a newer request', async () => {
    await request(true);
    gateway.holdNext = true;
    const before = notices.length;
    const older = request(false);
    await vi.waitFor(() => expect(gateway.release).toBeTypeOf('function'));
    expect(notices).toHaveLength(before);
    expect(await polling()).toBe(true);
    let settled = false;
    const newer = request(true).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    gateway.release!();
    await Promise.all([older, newer]);
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
    let settled = false;
    const newer = request(false).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseConfig!();
    await Promise.all([older, newer]);
    expect(await polling()).toBe(false);
    expect(extension.repo.getPollingIntent(space)).toBe(false);
  });
  test('a newer enable waits for an admitted older capability write before reading global state', async () => {
    await request(true);
    gateway.holdGlobal = true;
    const older = request(false);
    await vi.waitFor(() => expect(gateway.releaseGlobal).toBeTypeOf('function'));
    let settled = false;
    const newer = request(true).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    gateway.releaseGlobal!();
    await Promise.all([older, newer]);
    expect(await polling()).toBe(true);
    expect(extension.repo.getPollingIntent(space)).toBe(true);
  });
  test('a failed capability config write rejects once and releases the next independent update', async () => {
    await request(true);
    const before = notices.length,
      writes = gateway.writes;
    const set = vi
      .spyOn(store, 'setGlobalConfig')
      .mockRejectedValueOnce(new Error('synthetic config write rejected'));
    await expect(request(false)).rejects.toThrow('synthetic config write rejected');
    expect(gateway.writes).toBe(writes + 1);
    expect(notices).toHaveLength(before);
    set.mockRestore();
    await request(false);
    expect(gateway.writes).toBe(writes + 2);
    expect(await polling()).toBe(false);
  });
});
