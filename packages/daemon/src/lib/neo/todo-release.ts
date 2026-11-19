import { existsSync, realpathSync } from 'node:fs';
import simpleGit from 'simple-git';
import superpipe, { type PipelineAPI } from 'superpipe';
import { NEO_TODO_RELEASE_PRINCIPAL } from './session-archive-operation.ts';
import {
  branchesHeldElsewhere,
  WORKTREE_IN_USE,
  WORKTREE_UNVERIFIED,
} from '../drivers/work-placement.ts';
import type { WorkAdapter, WorkRef } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import type { OperationCaller } from '../operations/registry.ts';
import {
  neoWorkerKey,
  type NeoTodoSessionRepository,
} from '../../storage/repositories/neo-todo-session-repository.ts';

type FinishedWorker = ReturnType<NeoTodoSessionRepository['finishedWorkers']>[number];
type Invoke = (
  caller: OperationCaller,
  name: string,
  input: Record<string, unknown>
) => Promise<OperationOutcome>;
export type WorkerCompact = (adapter: string) => WorkAdapter['compact'];
type ReuseDecision = ReturnType<typeof followSessionReuse>;
type ReuseRelease =
  | { value: WorkRef }
  | { reason: Kept }
  | { compact: NonNullable<WorkAdapter['compact']>; ref: WorkRef; kept: Kept };
const COMPACT_RETRY_MS = 5 * 60_000;
const nextCompaction = new Map<string, number>();
let compactionInFlight = false;

function planKeptCompaction({
  ref,
  decision,
  hasLookup,
  compact,
  compactedAt,
  lastUse,
}: {
  ref: WorkRef;
  decision: ReuseDecision;
  hasLookup: boolean;
  compact: WorkAdapter['compact'];
  compactedAt: number | null | undefined;
  lastUse: number;
}): ReuseRelease {
  if ('value' in decision || !hasLookup) return decision;
  if (!compact) return { value: ref };
  if (compactedAt === undefined || (compactedAt !== null && compactedAt >= lastUse))
    return decision;
  return { compact, ref, kept: decision.reason };
}

type Released = { released: unknown };
type Kept = {
  kept:
    | 'named_by_human'
    | 'bound_to_live_todo'
    | 'remote_worker'
    | 'worker_folder_unknown'
    | 'sent_to_existing'
    | 'not_started_by_us'
    | 'kept_for_reuse';
};
type ReuseFacts = Awaited<ReturnType<NeoTodoSessionRepository['reuseFacts']>>;
type Folder = { ref: WorkRef; directory: string | null; dirty: boolean; unpushed: number };
type Pending = {
  pending: string;
  code:
    | 'dirty'
    | 'unpushed'
    | 'archive_refused'
    | 'worktree_in_use'
    | 'worktree_unverified'
    | 'error';
};

const RELEASE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const daemon: OperationCaller = {
  source: 'internal',
  role: 'neo',
  principal: NEO_TODO_RELEASE_PRINCIPAL,
};

export function planNeoTodoRelease(row: FinishedWorker): { value: WorkRef } | { reason: Kept } {
  if (row.target.verb === 'send' && !row.owned) return { reason: { kept: 'sent_to_existing' } };
  if (row.humanNamed) return { reason: { kept: 'named_by_human' } };
  if (row.shared) return { reason: { kept: 'bound_to_live_todo' } };
  if (row.ref.daemon) return { reason: { kept: 'remote_worker' } };
  if (!row.owned) return { reason: { kept: 'not_started_by_us' } };
  return { value: row.ref };
}

export function requireNeoWorkerSaved(
  folder: Folder
): { value: WorkRef } | { reason: Kept | Pending } {
  if (folder.directory === null) return { reason: { kept: 'worker_folder_unknown' } };
  if (folder.dirty)
    return { reason: { code: 'dirty', pending: `uncommitted changes in ${folder.directory}` } };
  if (folder.unpushed > 0)
    return {
      reason: {
        code: 'unpushed',
        pending: `${folder.unpushed} unpushed commits in ${folder.directory}`,
      },
    };
  return { value: folder.ref };
}

export function followSessionReuse(
  facts: ReuseFacts,
  ref: WorkRef
): { value: WorkRef } | { reason: Kept } {
  const keep =
    facts?.mode === 'per_ask'
      ? facts.hasFolder && facts.askOpen
      : facts?.mode === 'long_lived'
        ? facts.hasFolder && !facts.newerFree
        : false;
  return keep ? { reason: { kept: 'kept_for_reuse' } } : { value: ref };
}

async function readWorkerFolder(ref: WorkRef, invoke: Invoke): Promise<{ value: Folder }> {
  const outcome = await invoke(daemon, 'work.status', { ref });
  const status =
    outcome.kind === 'completed'
      ? (outcome.value as { value?: { execution?: { directory?: string } } } | null)
      : null;
  const directory = status?.value?.execution?.directory ?? null;
  const clean = { ref, directory, dirty: false, unpushed: 0 };
  if (!directory) return { value: clean };
  if (!existsSync(directory)) return { value: { ...clean, directory: null } };
  const git = simpleGit(directory);
  if (!(await git.checkIsRepo())) return { value: clean };
  const own = realpathSync((await git.revparse(['--show-toplevel'])).trim());
  const held = branchesHeldElsewhere(await git.raw(['worktree', 'list', '--porcelain']), own);
  const [state, unpushed] = await Promise.all([
    git.status(['--ignore-submodules=none']),
    git.raw(['rev-list', '--count', 'HEAD', '--not', '--remotes', '--tags', ...held]),
  ]);
  return { value: { ...clean, dirty: !state.isClean(), unpushed: Number(unpushed.trim()) } };
}

export function readNeoTodoArchive(
  outcome: OperationOutcome
): { value: Released } | { reason: Pending } {
  const result =
    outcome.kind === 'completed'
      ? (outcome.value as {
          ok?: boolean;
          reason?: string;
          value?: { worktree?: { reason?: string } };
        })
      : null;
  if (result?.reason === 'not_started_by_us')
    return { value: { released: { kept: 'not_started_by_us' } } };
  const kept = result?.value?.worktree?.reason;
  return result?.ok && kept !== WORKTREE_IN_USE && !kept?.startsWith(WORKTREE_UNVERIFIED)
    ? { value: { released: result } }
    : {
        reason: {
          code:
            kept === WORKTREE_IN_USE
              ? 'worktree_in_use'
              : kept?.startsWith(WORKTREE_UNVERIFIED)
                ? 'worktree_unverified'
                : 'archive_refused',
          pending: JSON.stringify(result ?? outcome).slice(0, 300),
        },
      };
}

const releaseWorker = (superpipe({})('neo.todo.release-worker') as PipelineAPI)
  .input(['row', 'invoke', 'sessions', 'workerCompact', 'now', 'warn'])
  .pipe(
    async (row: FinishedWorker, sessions: NeoTodoSessionRepository) => {
      if (!row.releasedBy) return { value: row };
      const released = { released: { sameWorkerAs: row.releasedBy } };
      await sessions.write('recordReleased', row.todoId, released.released);
      return { reason: released };
    },
    ['row', 'sessions'],
    'result:release'
  )
  .pipe(planNeoTodoRelease, 'release', 'result:release')
  .pipe(readWorkerFolder, ['release', 'invoke'], 'result:release')
  .pipe(requireNeoWorkerSaved, 'release', 'result:release')
  .pipe(
    async (
      ref: WorkRef,
      row: FinishedWorker,
      sessions: NeoTodoSessionRepository,
      lookup: WorkerCompact | undefined
    ) => {
      const decision = followSessionReuse(await sessions.read('reuseFacts', row.todoId), ref);
      const compact = 'reason' in decision ? lookup?.(ref.adapter) : undefined;
      const compactedAt = compact ? await sessions.read('workerCompactedAt', ref) : undefined;
      return { ref, decision, hasLookup: !!lookup, compact, compactedAt, lastUse: row.lastUse };
    },
    ['release', 'row', 'sessions', 'workerCompact'],
    'reuse'
  )
  .pipe(planKeptCompaction, 'reuse', 'compaction')
  .pipe(
    (
      plan: ReuseRelease,
      sessions: NeoTodoSessionRepository,
      now: number,
      warn: (message: string, error: unknown) => void
    ) => {
      if (!('compact' in plan)) return plan;
      const key = neoWorkerKey(plan.ref)!;
      if (compactionInFlight || (nextCompaction.get(key) ?? 0) > now) return { reason: plan.kept };
      compactionInFlight = true;
      const at = Date.now();
      const run = async () => {
        let confirmed = false;
        try {
          const result = await plan.compact(plan.ref, { caller: daemon, from: 'neo' });
          if (result.ok && result.value.compacted) {
            await sessions.recordWorkerCompacted(plan.ref, at);
            confirmed = true;
          }
        } finally {
          if (!confirmed) nextCompaction.set(key, Date.now() + COMPACT_RETRY_MS);
          compactionInFlight = false;
        }
      };
      void run().catch((error) => warn(`Worker ${key} compaction failed`, error));
      return { reason: plan.kept };
    },
    ['compaction', 'sessions', 'now', 'warn'],
    'result:release'
  )
  .pipe(
    async (ref: WorkRef, sessions: NeoTodoSessionRepository) => {
      const fence = await sessions.write('fenceWorkerRelease', ref, Date.now());
      if (fence === 'not_started_by_us') {
        const kept: Kept = { kept: 'not_started_by_us' };
        return { reason: kept };
      }
      return fence === 'fenced'
        ? { value: ref }
        : { reason: { kept: 'bound_to_live_todo' as const } };
    },
    ['release', 'sessions'],
    'result:release'
  )
  .pipe(
    async (ref: WorkRef, invoke: Invoke) =>
      readNeoTodoArchive(await invoke(daemon, 'neo.session.archive', { ref })),
    ['release', 'invoke'],
    'result:release'
  )
  .pipe(
    async (released: Released, row: FinishedWorker, sessions: NeoTodoSessionRepository) => {
      await sessions.write('recordReleased', row.todoId, released.released);
      return { value: released };
    },
    ['release', 'row', 'sessions'],
    'result:release'
  )
  .endAsync('release') as (
  row: FinishedWorker,
  invoke: Invoke,
  sessions: NeoTodoSessionRepository,
  workerCompact: WorkerCompact | undefined,
  now: number,
  warn: (message: string, error: unknown) => void
) => Promise<Released | Kept | Pending>;

export async function releaseNeoTodoWorkers(
  sessions: NeoTodoSessionRepository,
  invoke: Invoke,
  warn: (message: string, error: unknown) => void,
  now = Date.now(),
  wake?: (row: FinishedWorker, reason: string) => Promise<void>,
  workerCompact?: WorkerCompact
): Promise<void> {
  for (const [key, until] of nextCompaction) if (until <= now) nextCompaction.delete(key);
  const rows = await sessions.read('finishedWorkers', now - RELEASE_WINDOW_MS);
  const notified = new Set(
    rows.filter((row) => row.pending?.notified).map((row) => neoWorkerKey(row.ref))
  );
  for (const row of rows) {
    try {
      const outcome = await releaseWorker(row, invoke, sessions, workerCompact, now, warn).catch(
        (error: unknown): Pending => ({
          code: 'error',
          pending: error instanceof Error ? error.message : String(error),
        })
      );
      if ('kept' in outcome && outcome.kept === 'kept_for_reuse') {
        await sessions.write('recordReleaseKept', row.todoId, outcome);
      } else if ('kept' in outcome && outcome.kept !== 'bound_to_live_todo') {
        await sessions.write('recordReleased', row.todoId, outcome);
      } else if ('pending' in outcome) {
        const pending = {
          code: outcome.code,
          reason: outcome.pending,
          since: row.pending?.since ?? now,
          notified: row.pending?.notified ?? false,
        };
        if (row.pending?.code !== pending.code)
          warn(`Finished todo ${row.todoId} worker archive pending`, pending.reason);
        await sessions.write('recordReleasePending', row.todoId, pending);
        if (
          wake &&
          !notified.has(neoWorkerKey(row.ref)) &&
          now - pending.since >= 24 * 60 * 60 * 1000
        ) {
          try {
            await wake(row, pending.reason);
            notified.add(neoWorkerKey(row.ref));
            await sessions.write('recordReleasePending', row.todoId, {
              ...pending,
              notified: true,
            });
          } catch (error) {
            warn(`Finished todo ${row.todoId} worker notification pending`, error);
          }
        }
      }
    } catch (error) {
      warn(`Finished todo ${row.todoId} worker release failed`, error);
    }
  }
}
