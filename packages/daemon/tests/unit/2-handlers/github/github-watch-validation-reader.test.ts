import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitHubWatchedRepoRead } from '../../../../src/storage/repositories/github-watched-repo-read';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { InProcessTransport, MessageHub } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github/github-event-extension';
import { createExternalEventConfigStore } from '../../helpers/external-event-config-store';

const readName = 'github.watched.lookup.read';
class ValidationGateway extends DbGateway {
  reads = 0;
  finished = false;
  fail = false;
  hold = false;
  release?: () => void;
  override async run<A, R>(op: DbOp<A, R>, input: A): Promise<R> {
    if (op.name !== readName) return super.run(op, input);
    this.reads++;
    if (this.fail) throw new Error('synthetic validation reader failed');
    const result = await super.run(op, input);
    if (this.hold)
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    this.finished = true;
    return result;
  }
}

describe('watchRepo validation reader', () => {
  let db: Database, gateway: ValidationGateway, extension: GitHubEventExtension;
  let left: InProcessTransport, right: InProcessTransport, client: MessageHub;
  let store: ReturnType<typeof createExternalEventConfigStore>;
  const notices: string[] = [],
    space = 'synthetic-validation';
  const params = { spaceId: space, owner: 'mixed', repo: 'REPO', pollingEnabled: true };
  const pending = new Set<Promise<unknown>>();
  beforeEach(async () => {
    db = new Database(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    db.prepare(
      'INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,1,1)'
    ).run(space, space, 'synthetic-validation-workspace', space);
    gateway = new ValidationGateway(':memory:', db);
    bindGateway(db, gateway);
    store = createExternalEventConfigStore(db);
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
      spaceId: space,
      owner: 'Mixed',
      repo: 'repo',
      pollingEnabled: false,
      webhookEnabled: false,
    });
    notices.length = 0;
    client = new MessageHub();
    const server = new MessageHub();
    [left, right] = InProcessTransport.createPair();
    client.registerTransport(left);
    server.registerTransport(right);
    await Promise.all([left.initialize(), right.initialize()]);
    extension.registerRpcHandlers(server, {
      config: store,
      publisher: {
        publish: async () => {
          throw new Error('Unexpected publish');
        },
      },
      onSourceConfigChanged: (change) => {
        notices.push(change.kind);
      },
    });
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
  const request = (input: unknown = params) => {
    const p = client.request('space.github.watchRepo', input);
    pending.add(p);
    p.then(
      () => pending.delete(p),
      () => pending.delete(p)
    );
    return p;
  };
  const row = () =>
    db.prepare('SELECT * FROM space_github_watched_repos WHERE space_id=?').get(space);

  test('reads validation through the gateway before the interval gate', async () => {
    const previous = row();
    const read = vi.spyOn(extension.repo, 'getWatchedRepo').mockImplementation(() => {
      throw new Error('Validation lookup reached main');
    });
    await expect(request()).rejects.toThrow('GitHub polling is disabled globally');
    expect(gateway.reads).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(row()).toEqual(previous);
    expect(notices).toEqual([]);
  });

  test('awaits the validation receipt before any mutation', async () => {
    gateway.hold = true;
    const before = row(),
      upsert = vi.spyOn(extension.repo, 'upsertWatchedRepo');
    const result = request().then(
      () => 'accepted',
      (error: Error) => error.message
    );
    await vi.waitFor(() => expect(gateway.release).toBeTypeOf('function'));
    expect(upsert).not.toHaveBeenCalled();
    expect(row()).toEqual(before);
    expect(notices).toEqual([]);
    gateway.release!();
    expect(await result).toContain('GitHub polling is disabled globally');
  });

  test('reader rejection propagates with no main lookup or write fallback', async () => {
    gateway.fail = true;
    const before = row(),
      upsert = vi.spyOn(extension.repo, 'upsertWatchedRepo');
    const read = vi.spyOn(extension.repo, 'getWatchedRepo').mockImplementation(() => {
      throw new Error('Reader fallback');
    });
    await expect(request()).rejects.toThrow('synthetic validation reader failed');
    expect(gateway.reads).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(row()).toEqual(before);
    expect(notices).toEqual([]);
  });

  test('authorization and required parameters run before the reader', async () => {
    await expect(request({ spaceId: space })).rejects.toThrow(
      'spaceId, owner and repo are required'
    );
    const global = await store.getGlobalConfig('github');
    await store.setGlobalConfig('github', { ...global, globallyEnabled: false });
    await expect(request()).rejects.toThrow('GitHub RPC configuration capability is disabled');
    expect(gateway.reads).toBe(0);
  });
  test('registered reader preserves complete mapping, case matching and missing scope', async () => {
    expect(DB_OPS.get(readName)).toBe(gitHubWatchedRepoRead);
    expect(gitHubWatchedRepoRead.mode).toBe('read');
    const input = { spaceId: space, owner: 'mixed', repo: 'REPO' };
    expect(await gateway.run(gitHubWatchedRepoRead, input)).toEqual(
      extension.repo.getWatchedRepo(space, 'Mixed', 'repo')
    );
    expect(await gateway.run(gitHubWatchedRepoRead, { ...input, spaceId: 'missing' })).toBeNull();
    expect(await gateway.run(gitHubWatchedRepoRead, { ...input, repo: 'missing' })).toBeNull();
    db.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE space_id=?').run(
      '{broken',
      space
    );
    const before = row();
    await expect(gateway.run(gitHubWatchedRepoRead, input)).rejects.toThrow();
    expect(row()).toEqual(before);
  });

  test('complete reader measurement works without Git history below 200 lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-validation-scope-'));
    try {
      const output = join(dir, 'scope.json');
      writeFileSync(join(dir, 'git'), '#!/bin/sh\nexit 125\n', { mode: 0o700 });
      const bun = execFileSync('bun', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();
      execFileSync(bun, ['.claude/skills/verify/github-watch-validation-measure.cjs', output], {
        cwd: fileURLToPath(new URL('../../../../../../', import.meta.url)),
        env: { ...process.env, PATH: dir },
      });
      const report = JSON.parse(readFileSync(output, 'utf8'));
      expect(report.excludedLines).toBe(0);
      expect(report.productionGraphLines).toBe(178);
      expect(report.caller.lines).toBe(88);
      expect(report.modules).toHaveLength(3);
      for (const module of report.modules) {
        expect(module.counted).toBe(true);
        expect(module.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
