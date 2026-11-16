import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

test('createWorkCleanupRuntime bounds status calls and refreshes only matched refs before a kept archive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-runtime-'));
  const previous = process.env.HYPERNEO_DATA_DIR;
  process.env.HYPERNEO_DATA_DIR = root;
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  const folder = join(root, 'worktrees', 'worker');
  mkdirSync(folder, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, stdio: 'ignore' });
  git('init', '-q', '-b', 'dev');
  const imported = spawnSync('git', ['fast-import', '--quiet'], {
    cwd: folder,
    input:
      'commit refs/heads/dev\ncommitter Proof <proof@example.com> 1700000000 +0000\ndata 7\nfixture\n\ndone\n',
  });
  expect(imported.status).toBe(0);
  git('update-ref', 'refs/remotes/origin/dev', 'HEAD');
  const paths = new Map<string, string>();
  for (let index = 0; index < 12; index++) {
    const id = `worker-${index}`;
    const path = index === 0 ? folder : join(root, `missing-${index}`);
    paths.set(id, path);
    db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata,worktree_path)
      VALUES (?,?,'/work','now','now','archived','{}','{}',?)`).run(id, id, path);
  }
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
        return {
          ok: true,
          value: {
            ref,
            title: ref.id,
            status: 'stopped',
            lastActivityAt: 1,
            place: { machine: 'fixture', folder: '/work', name: 'Fixture' },
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
      execute: async () => {
        archives++;
        return {
          ok: true,
          value: {
            archived: true,
            worktree: { directory: folder, removed: false, reason: 'Unpublished branch; kept.' },
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
    expect(statusCalls).toBe(12);
    expect(peak).toBeLessThanOrEqual(4);
    expect(archives).toBe(1);
    expect(focused).toEqual([[{ adapter: 'hyperneo', id: 'worker-0' }]]);
    expect(result).toMatchObject({ removed: [], kept: { 'Unpublished branch; kept.': [folder] } });
  } finally {
    db.close();
    if (previous === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
