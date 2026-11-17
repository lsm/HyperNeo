import { existsSync, realpathSync } from 'node:fs';
import { lstat, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import {
  workCleanupReads,
  workCleanupWrites,
} from '../../storage/repositories/work-cleanup-worker.ts';
import { neoTodoSessionWrites } from '../../storage/repositories/neo-todo-session-repository.ts';
import { getDataDir } from '../data-dir.ts';
import { folderInUse, worktreeKeptUnsaved } from '../drivers/work-placement.ts';
import { workerWorkKey } from '../work-locations.ts';
import { codexWorkerHome, copilotWorkerDirectory } from '../drivers/worker-directories.ts';
import { WorkSummarySchema, type WorkRef } from '../drivers/types.ts';
import { NEO_TODO_RELEASE_PRINCIPAL } from '../neo/session-archive-operation.ts';
import { isNeoConversationSession } from '../neo/publication-read-operation.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { isLocalUser } from '../operations/caller.ts';
import { invokeOperation } from '../operations/invoke.ts';
import { defineOperation } from '../operations/registry.ts';
import type { FamilyOperationContext } from '../rpc-handlers/family-operations/context.ts';
import { planWorkRelease, type WorkFolderFacts, type WorkOwner } from './plan.ts';
import { insideFolder, listWorkCleanupFolders, sweepWorkCleanup } from './sweep.ts';
import { releaseWorkCleanup } from './release.ts';

const DAY = 24 * 60 * 60 * 1000;
const caller = { source: 'internal', role: 'neo', principal: NEO_TODO_RELEASE_PRINCIPAL } as const;
const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : path);
const presence = (path: string) =>
  lstat(path).then(
    () => 'present' as const,
    (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? 'absent' : 'unreadable')
  );
const isLive = ({ owner }: { owner: WorkOwner }) =>
  owner.kind === 'todo' ? owner.boundToLiveTodo : owner.kind === 'session' && !owner.archived;

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
    const evidenceRoot = join(data, 'work', 'evidence');
    const worktrees = new Map<string, string[]>();
    const insideEvidence = async (folder: string) => {
      const parent = await realpath(dirname(folder));
      if (
        parent !== join(await realpath(data), 'work', 'evidence') ||
        (await lstat(folder)).isSymbolicLink()
      )
        throw new Error(`${folder} resolves outside the evidence folder; kept.`);
    };
    const checked = new Set<string>();
    let cited: Set<string> | null = new Set<string>();
    const evidenceOwner = async (folder: string): Promise<WorkFolderFacts> => {
      const name = basename(folder);
      if (!cited) throw new Error('Reference read failed');
      const facts = await db.gateway.call(workCleanupReads, 'evidence', name);
      const referenced = checked.has(folder)
        ? (await db.gateway.call(workCleanupReads, 'referenced', [folder])).length > 0
        : cited.has(folder);
      checked.add(folder);
      const settled = { inUse: false, unsaved: false } as const;
      if (!/^hn-[0-9a-f]{12}$/.test(name))
        return facts.todo
          ? {
              ...settled,
              owner: { kind: 'todo', state: facts.todo.state, boundToLiveTodo: false },
              evidence: { since: facts.todo.since, referenced },
            }
          : { ...settled, owner: null };
      const paths = worktrees.get(name);
      if (!paths) return { ...settled, owner: null };
      const states = await Promise.all(paths.map(presence));
      if (states.includes('present')) {
        await db.gateway.call(workCleanupWrites, 'forgetGone', [name]);
        return { ...settled, owner: { kind: 'worktree', present: true } };
      }
      if (states.includes('unreadable')) return { ...settled, owner: 'unreadable' };
      if (facts.goneAt === null)
        await db.gateway.call(workCleanupWrites, 'markGone', name, Date.now());
      return {
        ...settled,
        owner: { kind: 'worktree', present: false },
        evidence: { since: facts.goneAt, referenced },
      };
    };
    const readEvidence = async (folder: string): Promise<WorkFolderFacts> => {
      await insideEvidence(folder);
      const facts = await evidenceOwner(folder);
      if ('keep' in planWorkRelease(facts, Date.now())) return facts;
      return { ...facts, inUse: await folderInUse(folder).catch(() => 'unreadable' as const) };
    };
    const unreadable = new Set<string>();
    const readFolder = async (folder: string): Promise<WorkFolderFacts> => {
      if (errors.has(folder)) throw new Error('Folder listing failed');
      if (insideFolder(evidenceRoot, folder)) return readEvidence(folder);
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
              new Map()
            )
          ).filter(
            (row) =>
              row.path === folder ||
              !row.readable ||
              (isLive(row) &&
                row.path !== null &&
                insideFolder(canonical(folder), canonical(row.path)))
          )
        : matched;
      read.add(folder);
      const row = owners.find(isLive) ?? owners[0];
      if (!row) return { owner: null, inUse: false, unsaved: false };
      refs.set(folder, row.ref);
      todos.set(
        folder,
        owners.flatMap(({ todoId }) => (todoId ? [todoId] : []))
      );
      if (!row.readable) return { owner: 'unreadable', inUse: false, unsaved: false };
      const facts = { owner: row.owner, inUse: false, unsaved: false };
      if ('keep' in planWorkRelease(facts, Date.now()) || !existsSync(folder)) return facts;
      return { ...facts, inUse: await folderInUse(folder).catch(() => 'unreadable' as const) };
    };
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
        for (const path of [
          ...folders,
          ...owned.flatMap((row) => (row.path ? [row.path] : [])),
          ...(await db.gateway.call(workCleanupReads, 'workerFolders')),
        ]) {
          const key = workerWorkKey(path);
          worktrees.set(key, [...(worktrees.get(key) ?? []), path]);
        }
        const evidence = await list(evidenceRoot);
        if (evidence.length)
          cited = await db.gateway.call(workCleanupReads, 'referenced', evidence).then(
            (paths) => new Set(paths),
            () => null
          );
        return [
          ...evidence,
          ...listWorkCleanupFolders(
            folders,
            owned.flatMap((row) => (row.path ? [{ path: row.path }] : [])),
            shared
          ),
          ...errors,
        ];
      },
      read: async (folder) => {
        const facts = await readFolder(folder);
        if (facts.owner === 'unreadable') unreadable.add(folder);
        else unreadable.delete(folder);
        return facts;
      },
      release: async (folder) => {
        if (insideFolder(evidenceRoot, folder)) {
          await insideEvidence(folder);
          await rm(folder, { recursive: true, force: true });
          if (worktrees.has(basename(folder)))
            await db.gateway.call(workCleanupWrites, 'forgetGone', [basename(folder)]);
          return true;
        }
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
        const now = Date.now();
        const unsaved = Object.entries(digest.kept).flatMap(([reason, folders]) =>
          worktreeKeptUnsaved(reason) ? folders : []
        );
        const settled = new Set([
          ...digest.removed.map(({ directory }) => directory),
          ...(digest.kept.live ?? []).filter((folder) => !unreadable.has(folder)),
        ]);
        const rows = new Map(
          (await db.gateway.call(workCleanupReads, 'gone')).map(({ key, goneAt }) => [key, goneAt])
        );
        await db.gateway.call(
          workCleanupWrites,
          'forgetGone',
          (
            await Promise.all(
              [...rows.keys()].map(async (key) => {
                const folder = key.slice(key.indexOf(':') + 1);
                return /^(unsaved|told):/.test(key) &&
                  !unsaved.includes(folder) &&
                  (settled.has(folder) || (await presence(folder)) === 'absent')
                  ? [key]
                  : [];
              })
            )
          ).flat()
        );
        for (const folder of unsaved)
          await db.gateway.call(workCleanupWrites, 'markGone', `unsaved:${folder}`, now);
        await context.workCleanupAttention?.({
          kind: 'work.cleanup',
          subject: { type: 'work_cleanup', id: 'local' },
          since: now,
          facts: {
            text: `Work cleanup: removed ${digest.removed.length} folders; volume available-space change: ${(after.bavail - before.bavail) * after.bsize} bytes. Kept by reason: ${JSON.stringify(digest.kept)}.`,
          },
        });
        for (const folder of unsaved) {
          const since = rows.get(`unsaved:${folder}`);
          if (since === undefined || now - since < 3 * DAY || rows.has(`told:${folder}`)) continue;
          const outcome = await context
            .workCleanupAttention?.({
              kind: 'work.cleanup',
              subject: { type: 'work_cleanup', id: `unsaved:${folder}` },
              since,
              facts: {
                text: `Unsaved work kept for 3 days at ${folder} (todo ${(todos.get(folder) ?? []).join(', ')}); Neo decides with the human.`,
              },
            })
            .catch(() => null);
          if (outcome && 'told' in outcome)
            await db.gateway.call(workCleanupWrites, 'markGone', `told:${folder}`, now);
        }
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
