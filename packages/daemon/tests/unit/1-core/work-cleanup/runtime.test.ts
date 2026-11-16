import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { FamilyOperationContext } from '../../../../src/lib/rpc-handlers/family-operations/context.ts';
import { WorkRefSchema } from '../../../../src/lib/drivers/types.ts';
import { createWorkCleanupRuntime } from '../../../../src/lib/work-cleanup/runtime.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { workCleanupReads } from '../../../../src/storage/repositories/work-cleanup-worker.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

test('createWorkCleanupRuntime matches all six root kinds, bounds status calls and skips probes for live or unreadable owners', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-runtime-')));
  const previous = process.env.HYPERNEO_DATA_DIR;
  const previousCodex = process.env.CODEX_HOME;
  const previousTrace = process.env.GIT_TRACE_SETUP;
  process.env.CODEX_HOME = join(root, 'codex');
  process.env.HYPERNEO_DATA_DIR = root;
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  const repo = join(root, 'source');
  const folders = [
    join(root, 'worktrees', 'worker'),
    join(root, 'projects', 'project', 'worktrees', 'worker'),
    join(root, 'claude-worktrees', 'repo', 'worker'),
    join(root, 'copilot-workers', 'worktrees', 'id8', 'repo'),
    join(root, 'codex', 'worktrees', 'id', 'repo'),
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
  const paths = new Map<string, string>();
  for (let index = 0; index < 14; index++) {
    const id = `worker-${index}`;
    const path =
      folders[index] ?? (index < 8 ? join(root, 'worktrees', id) : join(root, `missing-${index}`));
    if (index === 6 || index === 7) mkdirSync(path, { recursive: true });
    paths.set(id, path);
    db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata,worktree_path)
      VALUES (?,?,'/work','now','now',?,'{}','{}',?)`).run(
      id,
      id,
      index === 6 ? 'active' : 'archived',
      path
    );
  }
  const trace = join(root, 'git-trace.log');
  process.env.GIT_TRACE_SETUP = trace;
  let active = 0;
  let peak = 0;
  let statusCalls = 0;
  let archives = 0;
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
            execution: { directory: paths.get(ref.id), machine: 'fixture' },
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
        archives++;
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
  const gateway = gatewayFor(db);
  const context = {
    deps: {
      db: {
        getDatabase: () => db,
        gateway: {
          call: async (...args: unknown[]) => {
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
    expect(statusCalls).toBe(14);
    expect(peak).toBeLessThanOrEqual(4);
    expect(archives).toBe(6);
    expect(focused).toHaveLength(6);
    expect(focused.flat()).toEqual(
      expect.arrayContaining(
        folders.map((_, index) => ({ adapter: 'hyperneo', id: `worker-${index}` }))
      )
    );
    const digest = result as { kept: Record<string, string[]> };
    expect(digest.kept['Unpublished branch; kept.'].toSorted()).toEqual(folders.toSorted());
    expect(digest.kept.live).toHaveLength(2);
    expect(digest.kept.live).toContain(paths.get('worker-6'));
    expect(digest.kept.live).toContain(paths.get('worker-7'));
    const probes = readFileSync(trace, 'utf8');
    expect(probes).toContain(folders[0]);
    expect(probes).not.toContain(paths.get('worker-6')!);
    expect(probes).not.toContain(paths.get('worker-7')!);
  } finally {
    db.close();
    if (previous === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = previous;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
    if (previousTrace === undefined) delete process.env.GIT_TRACE_SETUP;
    else process.env.GIT_TRACE_SETUP = previousTrace;
    rmSync(root, { recursive: true, force: true });
  }
});
