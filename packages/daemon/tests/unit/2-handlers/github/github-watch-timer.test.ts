import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listGitHubPollingRepos,
  listGitHubPollingConfiguredRepos,
  countGitHubSpacesWithPollingIntent,
} from '../../../../src/storage/repositories/github-polling-repos-read';
import { listGitHubWatchedRepos } from '../../../../src/storage/repositories/github-watched-repos-read';
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
  configWrites = 0;
  holdNext = false;
  failNext = false;
  release?: () => void;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name === writeName) this.writes++;
    if (op.name === 'github.watched.config.write') this.configWrites++;
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
describe('Public watch timer callback reader wiring', () => {
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
  const watch = () => {
    const promise = client.request('space.github.watchRepo', {
      spaceId: space,
      owner: 'synthetic-owner',
      repo: 'repo',
      pollingEnabled: false,
      webhookEnabled: false,
    });
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
  test('approved two-module boundary pins complete files with 167 fresh and 267 known lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-reader-measure-'));
    try {
      const output = join(dir, 'boundary.json');
      execFileSync(
        process.execPath,
        ['.claude/skills/verify/lane-c-github-watch-measure.cjs', output],
        { cwd: fileURLToPath(new URL('../../../../../../', import.meta.url)) }
      );
      const report = JSON.parse(readFileSync(output, 'utf8'));
      expect(report).toMatchObject({
        fresh: 162,
        excludedLines: 100,
        knownTotal: 262,
        caller: { name: 'space.github.watchRepo', lines: 88, reviewedWatchBridgesOnly: true },
      });
      expect(
        report.data.filter((row: { auditedStable: boolean }) => row.auditedStable)
      ).toMatchObject([
        { lines: 56, sha256: '39618e09a7cd70b7325cf31b205eb221f338ebe58ff6ea50bebef49a22b28d06' },
        { lines: 44, sha256: '4c5945ea131459249bb302cdb27ee6a014fc6aadd5d15f9d402b3226972e6a95' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('audited query and mapper preserve scope, orphan selection, cursor data and parse errors', async () => {
    await request(true);
    extension.repo.upsertWatchedRepo({
      spaceId: 'synthetic-orphan',
      owner: 'orphan-owner',
      repo: 'orphan',
      pollingEnabled: true,
      webhookEnabled: false,
    });
    db.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE space_id=?').run(
      JSON.stringify({ lastEventId: 'synthetic-cursor' }),
      space
    );
    expect(listGitHubPollingRepos(db).map((row) => row.spaceId)).toEqual([
      'synthetic-orphan',
      space,
    ]);
    expect(listGitHubPollingRepos(db, space)).toMatchObject([
      {
        spaceId: space,
        owner: 'synthetic-owner',
        pollingEnabled: true,
        webhookEnabled: false,
        pollCursor: { lastEventId: 'synthetic-cursor' },
      },
    ]);
    expect(listGitHubPollingConfiguredRepos(db).map((row) => row.spaceId)).toEqual([space]);
    expect(countGitHubSpacesWithPollingIntent(db)).toBe(1);
    expect(listGitHubWatchedRepos(db, space)).toMatchObject([
      { spaceId: space, pollCursor: { lastEventId: 'synthetic-cursor' } },
    ]);
    db.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE space_id=?').run(
      '{',
      space
    );
    expect(() => listGitHubPollingRepos(db, space)).toThrow();
    expect(() => listGitHubWatchedRepos(db, space)).toThrow();
  });
  test('public watch awaits the reader and avoids the legacy main query', async () => {
    await request(true);
    expect(await active()).toBe(true);
    const list = extension.repo.listPollingRepos.bind(extension.repo);
    const spy = vi.spyOn(extension.repo, 'listPollingRepos').mockImplementation((scope) => {
      if (!scope) throw new Error('Timer SELECT reached main');
      return list(scope);
    });
    expect(await watch()).toMatchObject({
      watchedRepo: { spaceId: space, pollingEnabled: false },
      webhookUrl: '/webhook/github/space',
    });
    expect(extension.repo.getPollingIntent(space)).toBe(false);
    expect(extension.repo.listWatchedRepos(space)).toMatchObject([{ pollingEnabled: false }]);
    spy.mockRestore();
    expect(gateway.reads).toBe(1);
    expect(await active()).toBe(false);
  });
  test('no timer and a present session provider skip reader admission', async () => {
    await watch();
    expect(gateway.reads).toBe(0);
    await request(true);
    (
      extension as unknown as {
        options: { sessionWatchRepos?: () => { owner: string; repo: string }[] };
      }
    ).options.sessionWatchRepos = () => [];
    await watch();
    expect(gateway.reads).toBe(0);
    expect(await active()).toBe(true);
  });
  test('an active orphan row keeps the timer through the public watch mutation', async () => {
    await request(true);
    extension.repo.upsertWatchedRepo({
      spaceId: 'synthetic-orphan',
      owner: 'other-owner',
      repo: 'other-repo',
      enabled: true,
      pollingEnabled: true,
      webhookEnabled: false,
    });
    await watch();
    expect(gateway.reads).toBe(1);
    expect(await active()).toBe(true);
  });
  test('reader failure preserves the known write and timer, then releases a later independent update', async () => {
    await request(true);
    const before = notices.length;
    const beforeConfig = gateway.configWrites;
    gateway.failNext = true;
    await expect(watch()).rejects.toThrow('synthetic timer reader unavailable');
    expect(gateway.reads).toBe(1);
    expect(gateway.configWrites).toBe(beforeConfig + 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gateway.configWrites).toBe(beforeConfig + 1);
    expect(notices).toHaveLength(before);
    expect(extension.repo.getPollingIntent(space)).toBe(false);
    expect(extension.repo.listWatchedRepos(space)).toMatchObject([{ pollingEnabled: false }]);
    expect(await active()).toBe(true);
    await watch();
    expect(gateway.configWrites).toBe(beforeConfig + 2);
    expect(await active()).toBe(false);
  });
  test('an older unused timer reply completes before a newer enable effect can acknowledge', async () => {
    await request(true);
    gateway.holdNext = true;
    const before = notices.length;
    const older = watch();
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
    const older = watch();
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
