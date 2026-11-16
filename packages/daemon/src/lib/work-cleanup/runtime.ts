import { existsSync } from 'node:fs';
import { readdir, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { z } from 'zod';
import { workCleanupReads } from '../../storage/repositories/work-cleanup-worker.ts';
import { neoTodoSessionWrites } from '../../storage/repositories/neo-todo-session-repository.ts';
import { getDataDir } from '../data-dir.ts';
import { folderInUse } from '../drivers/work-placement.ts';
import { WorkSummarySchema, type WorkRef } from '../drivers/types.ts';
import { NEO_TODO_RELEASE_PRINCIPAL } from '../neo/session-archive-operation.ts';
import { isNeoConversationSession } from '../neo/publication-read-operation.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { isLocalUser } from '../operations/caller.ts';
import { invokeOperation } from '../operations/invoke.ts';
import { defineOperation } from '../operations/registry.ts';
import type { FamilyOperationContext } from '../rpc-handlers/family-operations/context.ts';
import type { WorkFolderFacts } from './plan.ts';
import { listWorkCleanupFolders, sweepWorkCleanup } from './sweep.ts';

const DAY = 24 * 60 * 60 * 1000;
const caller = { source: 'internal', role: 'neo', principal: NEO_TODO_RELEASE_PRINCIPAL } as const;

async function children(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function createWorkCleanupRuntime(context: FamilyOperationContext) {
  const { db, jobQueue, jobProcessor, sessionManager } = context.deps;
  const invoke = (name: string, input: Record<string, unknown>) =>
    invokeOperation(sessionManager.getOperationRegistry(), name, input, caller);
  const snapshot = async () => {
    const owners = await db.gateway.call(workCleanupReads, 'owners');
    return Promise.all(
      owners.map(async (row) => {
        const result = await invoke('work.status', { ref: row.ref });
        const parsed =
          result.kind === 'completed'
            ? z.object({ ok: z.literal(true), value: WorkSummarySchema }).safeParse(result.value)
            : null;
        return {
          ...row,
          path: parsed?.success ? (parsed.data.value.execution?.directory ?? row.path) : row.path,
          repo: row.repo ?? (parsed?.success ? parsed.data.value.place.folder : null),
          readable: parsed?.success === true,
        };
      })
    );
  };
  const execute = async () => {
    const refs = new Map<string, WorkRef>();
    const todos = new Map<string, string[]>();
    let initial: Awaited<ReturnType<typeof snapshot>> = [];
    const read = new Set<string>();
    const data = getDataDir();
    const before = await statfs(data);
    const digest = await sweepWorkCleanup({
      list: async () => {
        const owned = await snapshot();
        initial = owned;
        const repos = [...new Set(owned.flatMap((row) => (row.repo ? [row.repo] : [])))];
        const shared = [
          join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'worktrees'),
          ...repos.map((repo) => join(repo, '.claude', 'worktrees')),
        ];
        const projects = await children(join(data, 'projects'));
        const claude = await children(join(data, 'claude-worktrees'));
        const codex = await children(shared[0]);
        const roots = [
          join(data, 'worktrees'),
          join(data, 'copilot-workers', 'worktrees'),
          ...projects.map((project) => join(project, 'worktrees')),
          ...claude,
          ...codex,
          ...shared.slice(1),
        ];
        const folders = (await Promise.all(roots.map(children))).flat();
        return listWorkCleanupFolders(
          folders,
          owned.flatMap((row) => (row.path ? [{ path: row.path }] : [])),
          shared
        );
      },
      read: async (folder): Promise<WorkFolderFacts> => {
        const owners = (read.has(folder) ? await snapshot() : initial).filter(
          (row) => row.path === folder
        );
        read.add(folder);
        const live = owners.find(({ owner }) =>
          owner.kind === 'session' ? !owner.archived : owner.boundToLiveTodo
        );
        const row = live ?? owners[0];
        if (!row) return { owner: null, inUse: false, unsaved: false };
        refs.set(folder, row.ref);
        todos.set(
          folder,
          owners.flatMap(({ todoId }) => (todoId ? [todoId] : []))
        );
        if (!row.readable) return { owner: 'unreadable', inUse: false, unsaved: false };
        if (!existsSync(folder)) return { owner: row.owner, inUse: false, unsaved: false };
        try {
          const git = simpleGit(folder);
          const [status, ahead] = await Promise.all([
            git.status(['--ignore-submodules=none']),
            git.raw(['rev-list', '--count', 'HEAD', '--not', '--remotes', '--tags']),
          ]);
          const inUse = await folderInUse(folder);
          return {
            owner: row.owner,
            inUse,
            unsaved: !status.isClean() || Number(ahead.trim()) > 0,
          };
        } catch {
          return { owner: row.owner, inUse: 'unreadable', unsaved: 'unreadable' };
        }
      },
      release: async (folder) => {
        const ref = refs.get(folder);
        if (!ref || !(await db.gateway.call(neoTodoSessionWrites, 'fenceRelease', ref, Date.now())))
          return false;
        const result = await invoke('neo.session.archive', { ref });
        if (result.kind !== 'completed' || existsSync(folder)) return false;
        for (const todoId of todos.get(folder) ?? [])
          await db.gateway.call(neoTodoSessionWrites, 'recordReleased', todoId, result.value);
        return true;
      },
      tell: async (digest) => {
        const after = await statfs(data);
        await context.workCleanupAttention?.({
          kind: 'work.cleanup',
          subject: { type: 'work_cleanup', id: 'local' },
          since: Date.now(),
          facts: {
            text: `Work cleanup: removed ${digest.removed.length} folders; freed ${Math.max(0, (after.bavail - before.bavail) * after.bsize)} bytes. Kept by reason: ${JSON.stringify(digest.kept)}.`,
          },
        });
      },
    });
    return digest;
  };
  const queue = 'work.cleanup.sweep';
  const schedule = () =>
    jobQueue.enqueueUniquePending({
      queue,
      payload: {},
      matchPayload: {},
      activeStatuses: ['pending'],
      runAt: Date.now() + DAY,
    });
  jobProcessor.register(queue, async () => {
    try {
      return await execute();
    } finally {
      schedule();
    }
  });
  if (process.env.NODE_ENV !== 'test') schedule();
  return defineOperation({
    name: 'work.cleanup.sweep',
    description: 'Remove finished workers’ saved worktrees and tell Neo what was kept.',
    inputSchema: z.object({}),
    resultSchema: z.union([
      z.object({ removed: z.array(z.string()), kept: z.record(z.string(), z.array(z.string())) }),
      z.object({ accepted: z.literal(false), reason: z.literal('human_or_neo_only') }),
    ]),
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: async (_input, user) => {
      const binding = user.sessionId
        ? new NeoRepository(db.getDatabase()).getBindingBySession(user.sessionId)
        : null;
      if (!isLocalUser(user) && !isNeoConversationSession(user, binding))
        return { accepted: false, reason: 'human_or_neo_only' };
      return execute();
    },
  });
}
