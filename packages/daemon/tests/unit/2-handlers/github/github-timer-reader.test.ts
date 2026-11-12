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

const readName = 'github.polling.timer.read',
  writeName = 'github.space.polling.write';
class TimerGateway extends DbGateway {
  reads = 0;
  writes = 0;
  holdNext = false;
  failNext = false;
  release?: () => void;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name === writeName) this.writes++;
    if (op.name !== readName) return super.run(op, args);
    this.reads++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('synthetic timer reader unavailable');
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
describe('Public polling timer callback reader wiring', () => {
  let db: Database,
    gateway: TimerGateway,
    store: ExternalEventExtensionConfigStore,
    extension: GitHubEventExtension;
  let client: MessageHub, left: InProcessTransport, right: InProcessTransport;
  const space = 'synthetic-timer-reader',
    notices: string[] = [],
    pending = new Set<Promise<unknown>>();
  let context: Parameters<GitHubEventExtension['start']>[0];
  beforeEach(async () => {
    db = new Database(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    db.prepare(
      'INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,?,?)'
    ).run(space, space, 'synthetic-workspace', space, 1, 1);
    gateway = new TimerGateway(':memory:', db);
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
    context = {
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
  const active = async () =>
    (
      await client.request<{ polling: { active: boolean } }>('space.github.health', {
        spaceId: space,
        lightweight: true,
      })
    ).polling.active;
  test('complete timer caller and auth fit the measured scope without caller exclusions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timer-reader-measure-'));
    try {
      const output = join(dir, 'boundary.json');
      execFileSync(
        process.execPath,
        ['.claude/skills/verify/lane-c-github-timer-measure.cjs', output],
        { cwd: fileURLToPath(new URL('../../../../../../', import.meta.url)) }
      );
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        fullOwnedGraphLines: 165,
        excludedLines: 0,
        caller: {
          name: 'space.github.setPollingEnabled',
          lines: 28,
          onlyAwaitedTimerCallChanged: true,
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('public polling disable awaits the reader and avoids the legacy main query', async () => {
    await request(true);
    expect(await active()).toBe(true);
    const list = extension.repo.listPollingRepos.bind(extension.repo);
    const spy = vi.spyOn(extension.repo, 'listPollingRepos').mockImplementation((scope) => {
      if (!scope) throw new Error('Timer SELECT reached main');
      return list(scope);
    });
    expect(await request(false)).toEqual({ spaceId: space, pollingEnabled: false });
    spy.mockRestore();
    expect(gateway.reads).toBe(1);
    expect(await active()).toBe(false);
  });
  test('no timer and a present session provider skip reader admission', async () => {
    await request(false);
    expect(gateway.reads).toBe(0);
    await request(true);
    (
      extension as unknown as {
        options: { sessionWatchRepos?: () => { owner: string; repo: string }[] };
      }
    ).options.sessionWatchRepos = () => [];
    await request(false);
    expect(gateway.reads).toBe(0);
    expect(await active()).toBe(true);
  });
  test('an active orphan row keeps the timer through the public polling mutation', async () => {
    await request(true);
    extension.repo.upsertWatchedRepo({
      spaceId: 'synthetic-orphan',
      owner: 'other-owner',
      repo: 'other-repo',
      enabled: true,
      pollingEnabled: true,
      webhookEnabled: false,
    });
    await request(false);
    expect(gateway.reads).toBe(1);
    expect(await active()).toBe(true);
  });
  test('reader failure preserves the known write and timer, then releases a later independent update', async () => {
    await request(true);
    const before = notices.length,
      writes = gateway.writes;
    gateway.failNext = true;
    await expect(request(false)).rejects.toThrow('synthetic timer reader unavailable');
    expect(gateway.reads).toBe(1);
    expect(gateway.writes).toBe(writes + 1);
    expect(notices).toHaveLength(before);
    expect(extension.repo.getPollingIntent(space)).toBe(false);
    expect(await active()).toBe(true);
    await request(false);
    expect(gateway.writes).toBe(writes + 2);
    expect(await active()).toBe(false);
  });
  test('an older unused timer reply completes before a newer enable effect can acknowledge', async () => {
    await request(true);
    gateway.holdNext = true;
    const before = notices.length;
    const older = request(false);
    await vi.waitFor(() => expect(gateway.release).toBeTypeOf('function'));
    expect(notices).toHaveLength(before);
    let settled = false;
    const newer = request(true).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(await active()).toBe(true);
    gateway.release!();
    await Promise.all([older, newer]);
    expect(await active()).toBe(true);
    expect(await polling()).toBe(true);
  });
  test('a delayed unused reply cannot clear a timer belonging to a restarted lifetime', async () => {
    await request(true);
    gateway.holdNext = true;
    const older = request(false);
    await vi.waitFor(() => expect(gateway.release).toBeTypeOf('function'));
    await extension.stop();
    const global = await store.getGlobalConfig('github');
    await store.setGlobalConfig('github', {
      ...global,
      capabilities: { ...global.capabilities, polling: true },
    });
    await extension.start(context);
    expect(await active()).toBe(true);
    gateway.release!();
    await older;
    expect(await active()).toBe(true);
  });
});
