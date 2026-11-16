import { expect, test } from 'bun:test';
import type { WorkAdapter } from '../../../../src/lib/drivers/types.ts';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { workerWorkKey } from '../../../../src/lib/work-locations.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import {
  forgetWorkGone,
  recordStartedWork,
} from '../../../../src/storage/work-started-sessions.ts';

test("a worker placed again at a folder clears that folder's old gone row and no other", async () => {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  const root = '/work/worktrees/abc/repo';
  for (const key of [workerWorkKey(root), workerWorkKey('/work/worktrees/other/repo')])
    db.prepare('INSERT INTO work_cleanup_gone (key, gone_at) VALUES (?, ?)').run(key, 1);
  const place = { machine: 'imac', folder: '/focus/repo', name: 'repo' };
  const adapter: WorkAdapter = {
    id: 'codex-desktop',
    capabilities: ['start'],
    find: () => [],
    start: async (request) => ({
      ok: true,
      value: {
        ref: { adapter: 'codex-desktop', id: 'fresh' },
        title: request.title,
        place,
        status: 'running',
        lastActivityAt: 1,
        execution: { directory: root, machine: 'imac' },
      },
    }),
  };
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [adapter],
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'imac',
      freeWorkers: () => new Set(),
      recordStarted: (ref, directory) => {
        recordStartedWork(db, ref);
        if (directory) forgetWorkGone(db, directory);
      },
    } as Parameters<typeof createWorkVerbOperations>[0])
  );
  const started = await invokeOperation(
    registry,
    'work.start',
    { adapter: 'codex-desktop', place, title: 'loader', message: 'Fix the loader.' },
    { source: 'rpc', principal: 'local' }
  );
  expect(started).toMatchObject({ kind: 'completed', value: { ok: true } });
  expect(
    (db.prepare('SELECT key FROM work_cleanup_gone').all() as { key: string }[]).map((r) => r.key)
  ).toEqual([workerWorkKey('/work/worktrees/other/repo')]);
  db.close();
});
