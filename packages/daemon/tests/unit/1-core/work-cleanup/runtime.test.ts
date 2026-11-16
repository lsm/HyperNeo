import { expect, test } from 'bun:test';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../../../../src/config.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { FamilyOperationContext } from '../../../../src/lib/rpc-handlers/family-operations/context.ts';
import {
  codexWorkerHome,
  copilotWorkerDirectory,
} from '../../../../src/lib/drivers/worker-directories.ts';
import { WorkRefSchema, type WorkRef } from '../../../../src/lib/drivers/types.ts';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import { createWorkCleanupRuntime } from '../../../../src/lib/work-cleanup/runtime.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { workCleanupReads } from '../../../../src/storage/repositories/work-cleanup-worker.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

test.each(
  process.env.HYPERNEO_CLEANUP_FIXTURE
    ? [process.env.HYPERNEO_CLEANUP_MODE ?? 'plain']
    : [
        'plain',
        'listing failure',
        'rebound after listing',
        'start in flight',
        'bound without a folder',
      ]
)(
  'createWorkCleanupRuntime uses adapter roots and keeps listed or rebound folders safe: %s',
  async (mode) => {
    const listingFailure = mode === 'listing failure';
    const rebound = mode === 'rebound after listing';
    const inFlight = mode === 'start in flight';
    const unlocated = mode === 'bound without a folder';
    if (!process.env.HYPERNEO_CLEANUP_FIXTURE) {
      const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-runtime-')));
      mkdirSync(join(fixture, 'home'));
      try {
        const { stdout, stderr } = await promisify(execFile)(
          'bun',
          ['test', fileURLToPath(import.meta.url)],
          {
            env: {
              NODE_ENV: 'test',
              HYPERNEO_TEST_OWN_PROCESSES: '1',
              HOME: join(fixture, 'home'),
              PATH: process.env.PATH,
              HYPERNEO_CLEANUP_FIXTURE: fixture,
              HYPERNEO_CLEANUP_MODE: mode,
            },
            encoding: 'utf8',
          }
        );
        expect(stdout + stderr).toContain('1 pass');
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
      return;
    }
    const root = realpathSync(process.env.HYPERNEO_CLEANUP_FIXTURE);
    const previous = process.env.HYPERNEO_DATA_DIR;
    const previousCodex = process.env.CODEX_HOME;
    const previousHome = process.env.HOME;
    process.env.HOME = join(root, 'home');
    const config = getConfig({ dbPath: join(root, 'database', 'daemon.db') });
    process.env.CODEX_HOME = join(root, 'wrong-codex');
    process.env.HYPERNEO_DATA_DIR = root;
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    const repo = join(root, 'source');
    const copilotDirectory = copilotWorkerDirectory(config.dbPath);
    const codexHome = codexWorkerHome();
    expect(copilotDirectory).toBe(join(root, 'database', 'copilot-workers'));
    expect(codexHome).toBe(join(root, 'home', '.codex'));
    const folders = [
      join(root, 'worktrees', 'worker'),
      join(root, 'projects', 'project', 'worktrees', 'worker'),
      join(root, 'claude-worktrees', 'repo', 'worker'),
      join(copilotDirectory, 'worktrees', 'id8', 'repo'),
      join(codexHome, 'worktrees', 'id', 'repo'),
      join(repo, '.claude', 'worktrees', 'neo-worker'),
    ];
    for (const folder of [
      ...folders,
      join(root, 'worktrees', 'worker-6'),
      join(root, 'worktrees', 'worker-7'),
    ]) {
      mkdirSync(folder, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'dev'], { cwd: folder, stdio: 'ignore' });
      const imported = spawnSync('git', ['fast-import', '--quiet'], {
        cwd: folder,
        input:
          'commit refs/heads/dev\ncommitter Proof <proof@example.com> 1700000000 +0000\ndata 7\nfixture\n\ndone\n',
      });
      expect(imported.status).toBe(0);
      execFileSync('git', ['update-ref', 'refs/remotes/origin/dev', 'HEAD'], {
        cwd: folder,
        stdio: 'ignore',
      });
    }
    const unpublished = spawnSync('git', ['fast-import', '--quiet'], {
      cwd: folders[4],
      input:
        'commit refs/heads/dev\ncommitter Proof <proof@example.com> 1700000001 +0000\ndata 6\nlocal\nfrom refs/heads/dev^0\n\ndone\n',
    });
    expect(unpublished.status).toBe(0);
    const todos = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    todos.openAsk({
      id: 'ask',
      sessionId: 'neo',
      projectId: null,
      originMessageId: null,
      title: 'Cleanup',
      request: 'Cleanup',
      createdAt: 1,
    });
    const paths = new Map<string, string>();
    for (let index = 0; index < 14; index++) {
      const id = `worker-${index}`;
      const path =
        folders[index] ??
        (index < 8 ? join(root, 'worktrees', id) : join(root, `missing-${index}`));
      paths.set(id, path);
      if (index < 8) {
        db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata,worktree_path,main_repo_path)
        VALUES (?,?,'/work','now','now',?,'{}','{}',?,?)`).run(
          id,
          id,
          index >= 6 ? 'active' : 'archived',
          path,
          repo
        );
      } else {
        const todo = todos.addTodo(
          id,
          'ask',
          { title: id, doneWhen: 'Done', instruction: null, named: null, check: null },
          1
        );
        sessions.create(id, { verb: 'start', adapter: 'codex-desktop' });
        db.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(
          JSON.stringify({ adapter: 'codex-desktop', id }),
          id
        );
        todos.updateTodo(todo, { state: 'done', finishedAt: 2 }, 2);
      }
    }
    if (rebound) {
      const mover = todos.addTodo(
        'mover',
        'ask',
        { title: 'mover', doneWhen: 'Done', instruction: null, named: null, check: null },
        1
      );
      sessions.create(mover.id, { verb: 'start', adapter: 'codex-desktop' });
      db.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(
        JSON.stringify({ adapter: 'codex-desktop', id: 'mover' }),
        mover.id
      );
      todos.updateTodo(mover, { state: 'doing' }, 1);
      paths.set('mover', join(root, 'elsewhere'));
    }
    const broken = join(root, 'projects', 'broken', 'worktrees');
    if (listingFailure) {
      mkdirSync(join(root, 'projects', 'broken'), { recursive: true });
      writeFileSync(broken, 'not a directory');
    }
    let active = 0;
    let peak = 0;
    let statusCalls = 0;
    const archived: string[] = [];
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.status',
        description: 'Synthetic status',
        inputSchema: z.object({ ref: WorkRefSchema }),
        resultSchema: z.unknown(),
        execute: async ({ ref }) => {
          statusCalls++;
          active++;
          peak = Math.max(peak, active);
          await new Promise<void>((done) => setImmediate(done));
          active--;
          if (ref.id === 'worker-7')
            return { ok: false, reason: 'not_found', detail: 'Unreadable fixture' };
          return {
            ok: true,
            value: {
              ref,
              title: ref.id,
              status: 'stopped',
              lastActivityAt: 1,
              place: { machine: 'fixture', folder: repo, name: 'Fixture' },
              ...(ref.id === 'unlocated'
                ? {}
                : { execution: { directory: paths.get(ref.id), machine: 'fixture' } }),
            },
          };
        },
      }),
      defineOperation({
        name: 'neo.session.archive',
        description: 'Synthetic archive',
        inputSchema: z.object({ ref: WorkRefSchema }),
        resultSchema: z.unknown(),
        execute: async ({ ref }) => {
          archived.push(ref.id);
          return {
            ok: true,
            value: {
              archived: true,
              worktree: {
                directory: paths.get(ref.id),
                removed: false,
                reason: 'Unpublished branch; kept.',
              },
            },
          };
        },
      }),
    ]);
    const focused: unknown[] = [];
    let reads = 0;
    const gateway = gatewayFor(db);
    const context = {
      deps: {
        config,
        db: {
          getDatabase: () => db,
          gateway: {
            call: async (...args: unknown[]) => {
              if (args[0] === workCleanupReads && ++reads === 2) {
                const live = (id: string, target: NeoDriverTarget, ref: WorkRef | null) => {
                  const todo = todos.addTodo(
                    id,
                    'ask',
                    { title: id, doneWhen: 'Done', instruction: null, named: null, check: null },
                    3
                  );
                  sessions.create(todo.id, target);
                  if (ref)
                    db.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(
                      JSON.stringify(ref),
                      todo.id
                    );
                  todos.updateTodo(todo, { state: 'doing' }, 3);
                };
                if (rebound) {
                  live(
                    'named',
                    { verb: 'start', adapter: 'codex-desktop', name: 'Named' },
                    { adapter: 'codex-desktop', id: 'named' }
                  );
                  paths.set('named', folders[0]);
                  live(
                    'sent',
                    { verb: 'send', ref: { adapter: 'codex-desktop', id: 'sent' } },
                    null
                  );
                  paths.set('sent', folders[2]);
                  db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata,worktree_path,main_repo_path)
              VALUES ('placed','placed','/work','now','now','active','{}','{}',?,?)`).run(
                    folders[1],
                    repo
                  );
                }
                if (inFlight) live('starting', { verb: 'start', adapter: 'codex-desktop' }, null);
                const adopt = (id: string) => {
                  const todo = todos.addTodo(
                    id,
                    'ask',
                    { title: id, doneWhen: 'Done', instruction: null, named: null, check: null },
                    3
                  );
                  sessions.bind(todo.id, { adapter: 'codex-desktop', id }, 3);
                  todos.updateTodo(todo, { state: 'doing' }, 3);
                };
                if (rebound) {
                  paths.set('mover', folders[5]);
                  db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata)
              VALUES ('resident','resident',?,'now','now','active','{}','{}')`).run(folders[4]);
                  adopt('adopted');
                  paths.set('adopted', folders[3]);
                }
                if (unlocated) adopt('unlocated');
              }
              if (args[0] === workCleanupReads && args.length > 2) focused.push(args[2]);
              return Reflect.apply(gateway.call, gateway, args);
            },
          },
        },
        sessionManager: { getOperationRegistry: () => registry },
        jobProcessor: { register: () => {} },
        jobQueue: {},
      },
      workCleanupAttention: async () => {},
    } as unknown as FamilyOperationContext;
    try {
      const result = await createWorkCleanupRuntime(context).execute(
        {},
        { source: 'rpc', principal: 'local' }
      );
      const protectedFolders = inFlight || unlocated || rebound ? folders : [];
      const kept = folders.filter((folder) => !protectedFolders.includes(folder));
      expect(archived.toSorted()).toEqual(
        kept.map((folder) => `worker-${folders.indexOf(folder)}`)
      );
      expect(statusCalls).toBe(rebound ? 31 : unlocated ? 12 : 6);
      expect(peak).toBeLessThanOrEqual(4);
      expect(focused).toHaveLength(inFlight ? 0 : 6);
      if (!inFlight)
        expect(focused.flat()).toEqual(
          expect.arrayContaining(
            folders.map((_, index) => ({ adapter: 'hyperneo', id: `worker-${index}` }))
          )
        );
      const digest = result as { kept: Record<string, string[]> };
      expect((digest.kept['Unpublished branch; kept.'] ?? []).toSorted()).toEqual(kept.toSorted());
      expect(digest.kept.live.toSorted()).toEqual(
        [...protectedFolders, paths.get('worker-6')!, paths.get('worker-7')!].toSorted()
      );
      if (listingFailure) expect(digest.kept.error).toContain(broken);
    } finally {
      db.close();
      if (previous === undefined) delete process.env.HYPERNEO_DATA_DIR;
      else process.env.HYPERNEO_DATA_DIR = previous;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodex;
      rmSync(root, { recursive: true, force: true });
    }
  }
);
