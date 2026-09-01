import superpipe, { type PipelineAPI } from 'superpipe';
import {
  buildPostApprovalSessionId,
  sanitizeAgentNameForId,
} from '../session/sub-session-identity.ts';
import type { SessionResolutionDeps, WorkerExecutionSession } from './deps.ts';
import type { EnsureSessionOutcome, SessionTargetWorker } from './target.ts';

export type WorkerSessionPhase = 'run_active' | 'done';

export const WORKER_SESSION_POLL_INTERVAL_MS = 1_000;
export const WORKER_SESSION_WAIT_CAP_MS = 30_000;

export function newestWorkerSessionId(rows: WorkerExecutionSession[]): string | null {
  const live = rows.filter(
    (row) => row.sessionId !== null && row.status !== 'cancelled' && row.status !== 'pending'
  );
  return live.at(-1)?.sessionId ?? null;
}

export function workerSessionPhase(rows: WorkerExecutionSession[]): WorkerSessionPhase {
  return rows.some((row) => row.status !== 'cancelled') ? 'run_active' : 'done';
}

export async function findStage(
  target: SessionTargetWorker,
  deps: SessionResolutionDeps
): Promise<{ foundSessionId: string | undefined; outcome: EnsureSessionOutcome | undefined }> {
  const sessionId = newestWorkerSessionId(deps.listWorkerExecutions(target));
  if (sessionId === null) {
    return { foundSessionId: undefined, outcome: undefined };
  }
  if ((await deps.rehydrateSubSession(sessionId)) === null) {
    return { foundSessionId: undefined, outcome: undefined };
  }
  return { foundSessionId: sessionId, outcome: { kind: 'resolved', sessionId, created: false } };
}

export function phaseStage(
  target: SessionTargetWorker,
  deps: SessionResolutionDeps
): {
  phase: WorkerSessionPhase;
  postApprovalArm: typeof postApprovalStage | undefined;
  activateArm: typeof activateStage | undefined;
} {
  if (workerSessionPhase(deps.listWorkerExecutions(target)) === 'done') {
    return { phase: 'done', postApprovalArm: postApprovalStage, activateArm: undefined };
  }
  return { phase: 'run_active', postApprovalArm: undefined, activateArm: activateStage };
}

export async function postApprovalStage(
  target: SessionTargetWorker,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  const spaceId = await deps.getTaskSpaceId(target.taskId);
  if (spaceId === null) {
    return { kind: 'unresolved', reason: 'task_not_found' };
  }
  const postApprovalSessionId = buildPostApprovalSessionId(
    spaceId,
    target.taskId,
    sanitizeAgentNameForId(target.agentName)
  );
  const existing = await deps.getSession(postApprovalSessionId);
  if (existing !== null) {
    return { kind: 'resolved', sessionId: postApprovalSessionId, created: false };
  }
  const spawnedSessionId = await deps.spawnPostApprovalWorker(
    target.taskId,
    target.agentName,
    target.workflowNodeId
  );
  if (spawnedSessionId === null) {
    return { kind: 'unresolved', reason: 'spawn_failed' };
  }
  return { kind: 'resolved', sessionId: spawnedSessionId, created: true };
}

export async function activateStage(
  target: SessionTargetWorker,
  deps: SessionResolutionDeps
): Promise<{ activated: boolean; outcome: EnsureSessionOutcome | undefined }> {
  const activated = await deps.activateTaskAgent(target);
  if (!activated) {
    return { activated: false, outcome: { kind: 'unresolved', reason: 'activate_failed' } };
  }
  return { activated: true, outcome: undefined };
}

interface DelayHandle {
  promise: Promise<void>;
  cancel: () => void;
  fired: boolean;
}

const delay = (ms: number): DelayHandle => {
  const handle: DelayHandle = { promise: Promise.resolve(), cancel: () => {}, fired: false };
  handle.promise = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      handle.fired = true;
      resolve();
    }, ms);
    handle.cancel = () => clearTimeout(timer);
  });
  return handle;
};

export async function awaitSessionStage(
  target: SessionTargetWorker,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  const cap = delay(WORKER_SESSION_WAIT_CAP_MS);
  try {
    for (;;) {
      if (cap.fired) {
        return { kind: 'unresolved', reason: 'activation_timeout' };
      }
      const sessionId = newestWorkerSessionId(deps.listWorkerExecutions(target));
      if (sessionId !== null && (await deps.rehydrateSubSession(sessionId)) !== null) {
        return { kind: 'resolved', sessionId, created: true };
      }
      const tick = delay(WORKER_SESSION_POLL_INTERVAL_MS);
      await Promise.race([tick.promise, cap.promise]);
      tick.cancel();
    }
  } finally {
    cap.cancel();
  }
}

const settled = (outcome?: EnsureSessionOutcome): boolean => outcome !== undefined;

export function crashHandler(error: unknown): EnsureSessionOutcome {
  return {
    kind: 'unresolved',
    reason: `internal: ${error instanceof Error ? error.message : String(error)}`,
  };
}

const runEnsureWorkerSession = (
  superpipe<{ settled: (outcome?: EnsureSessionOutcome) => boolean }>({
    settled,
  })('ensure-worker-session') as PipelineAPI
)
  .input(['target', 'deps'])
  .pipe(findStage, ['target', 'deps'], ['foundSessionId', 'outcome'])
  .pipe('!settled', 'outcome')
  .pipe(phaseStage, ['target', 'deps'], ['phase', 'postApprovalArm', 'activateArm'])
  .pipe('?postApprovalArm', ['target', 'deps'], 'outcome')
  .pipe('!settled', 'outcome')
  .pipe('?activateArm', ['target', 'deps'], ['activated', 'outcome'])
  .pipe('!settled', 'outcome')
  .pipe(awaitSessionStage, ['target', 'deps'], 'outcome')
  .error(crashHandler, ['error'])
  .endAsync('outcome') as (
  target: SessionTargetWorker,
  deps: SessionResolutionDeps
) => Promise<EnsureSessionOutcome>;

export async function ensureWorkerSession(
  target: SessionTargetWorker,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  return runEnsureWorkerSession(target, deps).catch(crashHandler);
}
