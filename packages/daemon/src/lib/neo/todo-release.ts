import { existsSync } from 'node:fs';
import simpleGit from 'simple-git';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { WorkRef } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import type { OperationCaller } from '../operations/registry.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';

type FinishedWorker = ReturnType<NeoTodoSessionRepository['finishedWorkers']>[number];
type Invoke = (
  caller: OperationCaller,
  name: string,
  input: Record<string, unknown>
) => Promise<OperationOutcome>;
type Released = { released: unknown };
type Kept = {
  kept: 'not_started_by_todo' | 'named_by_human' | 'bound_to_live_todo' | 'remote_worker';
};
type Folder = { ref: WorkRef; directory: string | null; dirty: boolean; unpushed: number };
type Pending = { pending: string };

const RELEASE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const daemon: OperationCaller = { source: 'internal', role: 'neo' };

export function planNeoTodoRelease(row: FinishedWorker): { value: WorkRef } | { reason: Kept } {
  if (row.target.verb !== 'start') return { reason: { kept: 'not_started_by_todo' } };
  if (row.target.name) return { reason: { kept: 'named_by_human' } };
  if (row.shared) return { reason: { kept: 'bound_to_live_todo' } };
  if (row.ref.daemon) return { reason: { kept: 'remote_worker' } };
  return { value: row.ref };
}

export function requireNeoWorkerSaved(folder: Folder): { value: WorkRef } | { reason: Pending } {
  if (folder.directory === null) return { reason: { pending: 'worker folder unknown' } };
  if (folder.dirty) return { reason: { pending: `uncommitted changes in ${folder.directory}` } };
  if (folder.unpushed > 0)
    return { reason: { pending: `${folder.unpushed} unpushed commits in ${folder.directory}` } };
  return { value: folder.ref };
}

async function readWorkerFolder(ref: WorkRef, invoke: Invoke): Promise<{ value: Folder }> {
  const outcome = await invoke(daemon, 'work.status', { ref });
  const status =
    outcome.kind === 'completed'
      ? (outcome.value as { value?: { execution?: { directory?: string } } } | null)
      : null;
  const directory = status?.value?.execution?.directory ?? null;
  const clean = { ref, directory, dirty: false, unpushed: 0 };
  if (!directory || !existsSync(directory)) return { value: clean };
  const git = simpleGit(directory);
  if (!(await git.checkIsRepo())) return { value: clean };
  const [state, unpushed] = await Promise.all([
    git.status(['--ignore-submodules=none']),
    git.raw(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']),
  ]);
  return { value: { ...clean, dirty: !state.isClean(), unpushed: Number(unpushed.trim()) } };
}

export function readNeoTodoArchive(
  outcome: OperationOutcome
): { value: Released } | { reason: Pending } {
  const result = outcome.kind === 'completed' ? (outcome.value as { ok?: boolean }) : null;
  return result?.ok
    ? { value: { released: result } }
    : { reason: { pending: JSON.stringify(result ?? outcome).slice(0, 300) } };
}

const releaseWorker = (superpipe({})('neo.todo.release-worker') as PipelineAPI)
  .input(['row', 'invoke', 'sessions'])
  .pipe(planNeoTodoRelease, 'row', 'result:release')
  .pipe(readWorkerFolder, ['release', 'invoke'], 'result:release')
  .pipe(requireNeoWorkerSaved, 'release', 'result:release')
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
  sessions: NeoTodoSessionRepository
) => Promise<Released | Kept | Pending>;

export async function releaseNeoTodoWorkers(
  sessions: NeoTodoSessionRepository,
  invoke: Invoke,
  warn: (message: string, error: unknown) => void,
  now = Date.now()
): Promise<void> {
  for (const row of await sessions.read('finishedWorkers', now - RELEASE_WINDOW_MS)) {
    const outcome = await releaseWorker(row, invoke, sessions).catch((error: unknown) => ({
      pending: error instanceof Error ? error.message : String(error),
    }));
    if ('pending' in outcome)
      warn(`Finished todo ${row.todoId} worker archive pending`, outcome.pending);
  }
}
