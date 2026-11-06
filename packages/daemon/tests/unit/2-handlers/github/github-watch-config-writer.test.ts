import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { InProcessTransport, MessageHub } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github/github-event-extension';
import { createExternalEventConfigStore } from '../../helpers/external-event-config-store';

const writeName = 'github.watched.config.write';
class ConfigGateway extends DbGateway {
  writes = 0;
  fail = false;
  lose = false;
  hold = false;
  release?: () => void;
  override async run<A, R>(op: DbOp<A, R>, input: A): Promise<R> {
    if (op.name !== writeName) return super.run(op, input);
    this.writes++;
    if (this.fail) throw new Error('synthetic config admission refused');
    if (this.hold)
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    const result = await super.run(op, input);
    if (this.lose) throw new Error('synthetic config outcome unknown');
    return result;
  }
}

describe('watchRepo atomic config writer', () => {
  let db: Database, gateway: ConfigGateway, extension: GitHubEventExtension;
  let left: InProcessTransport, right: InProcessTransport, client: MessageHub;
  let store: ReturnType<typeof createExternalEventConfigStore>;
  const notices: string[] = [],
    space = 'synthetic-config-writer';
  const params = {
    spaceId: space,
    owner: 'mixed',
    repo: 'REPO',
    pollingEnabled: false,
    webhookSecret: 'rotated',
  };
  const pending = new Set<Promise<unknown>>();
  beforeEach(async () => {
    db = new Database(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    db.prepare(
      'INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,1,1)'
    ).run(space, space, 'synthetic-validation-workspace', space);
    gateway = new ConfigGateway(':memory:', db);
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
      webhookEnabled: true,
      webhookSecret: 'original',
      webhookAutoRegistered: true,
    });
    db.prepare('UPDATE space_github_watched_repos SET last_webhook_at=13 WHERE space_id=?').run(
      space
    );
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

  test('public receipt is committed without legacy main upsert or reread', async () => {
    const upsert = vi.spyOn(extension.repo, 'upsertWatchedRepo').mockImplementation(() => {
      throw new Error('Main watched upsert');
    });
    const reread = vi.spyOn(extension.repo, 'getWatchedRepoById').mockImplementation(() => {
      throw new Error('Main watched reread');
    });
    const response = await request();
    expect(response).toMatchObject({
      watchedRepo: { owner: 'Mixed', webhookSecret: 'configured', webhookAutoRegistered: false },
    });
    expect(gateway.writes).toBe(1);
    expect(upsert).not.toHaveBeenCalled();
    expect(reread).not.toHaveBeenCalled();
    expect(row()).toMatchObject({
      webhook_secret: 'rotated',
      webhook_auto_registered: 0,
      last_webhook_at: null,
    });
    expect(notices).toEqual(['watched_repo_changed']);
  });

  test('a failed clear rolls back the complete preceding upsert', async () => {
    const before = row();
    db.exec(
      "CREATE TRIGGER reject_config_clear BEFORE UPDATE OF webhook_auto_registered ON space_github_watched_repos WHEN NEW.webhook_auto_registered=0 BEGIN SELECT RAISE(ABORT,'synthetic clear refusal'); END"
    );
    await expect(request()).rejects.toThrow('synthetic clear refusal');
    expect(row()).toEqual(before);
    expect(notices).toEqual([]);
  });

  test('writer admission failure leaves the complete original row and no notification', async () => {
    gateway.fail = true;
    const before = row();
    await expect(request()).rejects.toThrow('synthetic config admission refused');
    expect(gateway.writes).toBe(1);
    expect(row()).toEqual(before);
    expect(notices).toEqual([]);
  });

  test('unknown committed outcome never replays or emits a success notification', async () => {
    gateway.lose = true;
    await expect(request()).rejects.toThrow('synthetic config outcome unknown');
    const committed = row();
    expect(committed).toMatchObject({ webhook_secret: 'rotated', webhook_auto_registered: 0 });
    await new Promise((done) => setTimeout(done, 60));
    expect(gateway.writes).toBe(1);
    expect(row()).toEqual(committed);
    expect(notices).toEqual([]);
  });

  test('the public caller awaits the writer before persisting a snapshot', async () => {
    gateway.hold = true;
    const before = row(),
      snapshot = vi.spyOn(store, 'setSpaceConfig');
    const result = request();
    await vi.waitFor(() => expect(gateway.release).toBeTypeOf('function'));
    expect(row()).toEqual(before);
    expect(snapshot).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    gateway.release!();
    await result;
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});

describe('Watch config scope measurement', () => {
  test('the CLI refuses a missing admission gate instead of reporting a null budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'watch-config-scope-'));
    const repo = fileURLToPath(new URL('../../../../../../', import.meta.url));
    const files = [
      'lib/external-events/github/github-event-extension.ts',
      'lib/external-events/github/github-repository.ts',
      'storage/db-gateway/db-ops.ts',
      'storage/repositories/github-watched-config-write.ts',
      'storage/repositories/github-webhook-clear-persist.ts',
      'storage/repositories/github-watched-repo-read.ts',
    ];
    try {
      for (const file of files) {
        const path = join(root, 'packages/daemon/src', file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          file.endsWith('github-event-extension.ts')
            ? "hub.onRequest('space.github.watchRepo', async () => {});\n"
            : 'export {};\n'
        );
      }
      mkdirSync(join(root, 'bin'));
      writeFileSync(
        join(root, 'bin/git'),
        '#!/bin/sh\nif [ "$1" = diff ]; then exit 0; fi\nexit 1\n',
        { mode: 0o700 }
      );
      symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
      const bun = execFileSync('bun', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();
      expect(() =>
        execFileSync(bun, [join(repo, '.claude/skills/verify/github-watch-config-measure.cjs')], {
          cwd: root,
          env: { ...process.env, PATH: join(root, 'bin') },
          stdio: 'pipe',
        })
      ).toThrow('Missing complete caller or admission gate');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
