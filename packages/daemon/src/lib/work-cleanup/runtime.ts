import { existsSync } from 'node:fs';
import { readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { z } from 'zod';
import { workCleanupReads } from '../../storage/repositories/work-cleanup-worker.ts';
import { neoTodoSessionWrites } from '../../storage/repositories/neo-todo-session-repository.ts';
import { getDataDir } from '../data-dir.ts';
import { folderInUse } from '../drivers/work-placement.ts';
import { codexWorkerHome, copilotWorkerDirectory } from '../drivers/worker-directories.ts';
import { WorkSummarySchema, type WorkRef } from '../drivers/types.ts';
import { NEO_TODO_RELEASE_PRINCIPAL } from '../neo/session-archive-operation.ts';
import { isNeoConversationSession } from '../neo/publication-read-operation.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { isLocalUser } from '../operations/caller.ts';
import { invokeOperation } from '../operations/invoke.ts';
import { defineOperation } from '../operations/registry.ts';
import type { FamilyOperationContext } from '../rpc-handlers/family-operations/context.ts';
import { planWorkRelease, type WorkFolderFacts } from './plan.ts';
import { listWorkCleanupFolders, sweepWorkCleanup } from './sweep.ts';
import { releaseWorkCleanup } from './release.ts';

const DAY = 24 * 60 * 60 * 1000;
const caller = { source: 'internal', role: 'neo', principal: NEO_TODO_RELEASE_PRINCIPAL } as const;

async function children(root: string, errors: Set<string>): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.add(root);
    return [];
  }
}

export function createWorkCleanupRuntime(context: FamilyOperationContext) {
  const { db, jobQueue, jobProcessor, sessionManager, config } = context.deps;
  const invoke = (name: string, input: Record<string, unknown>) =>
    invokeOperation(sessionManager.getOperationRegistry(), name, input, caller);
  const readOwners = (refs?: WorkRef[], folder?: string) =>
    refs
      ? db.gateway.call(workCleanupReads, 'owners', refs, folder)
      : db.gateway.call(workCleanupReads, 'owners');
  type Owners = Awaited<ReturnType<typeof readOwners>>;
  const resolveOwners = async (
    owners: Owners,
    statuses: Map<string, ReturnType<typeof invoke>>
  ) => {
    const rows: (Owners[number] & { readable: boolean })[] = [];
    for (let offset = 0; offset < owners.length; offset += 4) {
      rows.push(
        ...(await Promise.all(
          owners.slice(offset, offset + 4).map(async (row) => {
            if (row.path) return { ...row, readable: true };
            const key = JSON.stringify([row.ref.adapter, row.ref.id]);
            if (!statuses.has(key)) statuses.set(key, invoke('work.status', { ref: row.ref }));
            const result = await statuses.get(key)!;
            const parsed =
              result.kind === 'completed'
                ? z
                    .object({ ok: z.literal(true), value: WorkSummarySchema })
                    .safeParse(result.value)
                : null;
            const value = parsed?.success ? parsed.data.value : null;
            const directory = value?.execution?.directory ?? null;
            return {
              ...row,
              path: directory ?? row.path,
              repo: row.repo ?? value?.place.folder ?? null,
              readable: directory !== null,
            };
          })
        ))
      );
    }
    return rows;
  };
  const execute = async () => {
    const errors = new Set<string>();
    const list = (root: string) => children(root, errors);
    const refs = new Map<string, WorkRef>();
    const todos = new Map<string, string[]>();
    const statuses = new Map<string, ReturnType<typeof invoke>>();
    let initial: Awaited<ReturnType<typeof resolveOwners>> = [];
    const read = new Set<string>();
    const data = getDataDir();
    const before = await statfs(data);
    const digest = await sweepWorkCleanup({
      list: async () => {
        const owned = await resolveOwners(await readOwners(), statuses);
        initial = owned;
        const repos = [...new Set(owned.flatMap((row) => (row.repo ? [row.repo] : [])))];
        const shared = [
          join(codexWorkerHome(), 'worktrees'),
          ...repos.map((repo) => join(repo, '.claude', 'worktrees')),
        ];
        const projects = await list(join(data, 'projects'));
        const claude = await list(join(data, 'claude-worktrees'));
        const codex = await list(shared[0]);
        const copilot = await list(join(copilotWorkerDirectory(config.dbPath), 'worktrees'));
        const roots = [
          join(data, 'worktrees'),
          ...projects.map((project) => join(project, 'worktrees')),
          ...claude,
          ...codex,
          ...copilot,
          ...shared.slice(1),
        ];
        const folders = (await Promise.all(roots.map(list))).flat();
        return [
          ...listWorkCleanupFolders(
            folders,
            owned.flatMap((row) => (row.path ? [{ path: row.path }] : [])),
            shared
          ),
          ...errors,
        ];
      },
      read: async (folder): Promise<WorkFolderFacts> => {
        if (errors.has(folder)) throw new Error('Folder listing failed');
        const matched = initial.filter((row) => row.path === folder);
        const fresh = read.has(folder);
        const bound = fresh ? await db.gateway.call(workCleanupReads, 'liveBindings') : [];
        if (bound.some(({ ref }) => !ref))
          return { owner: 'unreadable', inUse: false, unsaved: false };
        const owners = fresh
          ? (
              await resolveOwners(
                [
                  ...(await readOwners(
                    matched.map(({ ref }) => ref),
                    folder
                  )),
                  ...bound.flatMap(({ ref, todoId, state }) =>
                    ref
                      ? [
                          {
                            ref,
                            todoId,
                            path: null,
                            repo: null,
                            owner: { kind: 'todo' as const, state, boundToLiveTodo: true },
                          },
                        ]
                      : []
                  ),
                ],
                statuses
              )
            ).filter((row) => row.path === folder || !row.readable)
          : matched;
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
        const facts = { owner: row.owner, inUse: false, unsaved: false };
        if ('keep' in planWorkRelease(facts, Date.now()) || !existsSync(folder)) return facts;
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
        if (!ref) return { keep: 'unknown' };
        return releaseWorkCleanup(
          folder,
          todos.get(folder) ?? [],
          () => db.gateway.call(neoTodoSessionWrites, 'fenceRelease', ref, Date.now()),
          () => invoke('neo.session.archive', { ref }),
          (todoId, receipt) =>
            db.gateway.call(neoTodoSessionWrites, 'recordReleased', todoId, receipt)
        );
      },
      tell: async (digest) => {
        const after = await statfs(data);
        await context.workCleanupAttention?.({
          kind: 'work.cleanup',
          subject: { type: 'work_cleanup', id: 'local' },
          since: Date.now(),
          facts: {
            text: `Work cleanup: removed ${digest.removed.length} folders; volume available-space change: ${(after.bavail - before.bavail) * after.bsize} bytes. Kept by reason: ${JSON.stringify(digest.kept)}.`,
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
      z.object({
        removed: z.array(z.object({ directory: z.string(), reason: z.string() })),
        kept: z.record(z.string(), z.array(z.string())),
      }),
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
