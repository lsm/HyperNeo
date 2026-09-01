import superpipe, { type PipelineAPI } from 'superpipe';
import type { SessionResolutionDeps, WorkerExecutionSession, WorkerTaskPhase } from './deps.ts';
import type { EnsureSessionOutcome, SessionTargetWorker } from './target.ts';

export const WORKER_SESSION_POLL_INTERVAL_MS = 1_000;
export const WORKER_SESSION_WAIT_CAP_MS = 30_000;

export function newestWorkerSessionId(rows: WorkerExecutionSession[]): string | null {
  const live = rows.filter(
    (row) => row.sessionId !== null && row.status !== 'cancelled' && row.status !== 'pending'
  );
  return live.at(-1)?.sessionId ?? null;
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
  const phase = deps.readWorkerTaskPhase(target.taskId);
  if (phase !== 'run_active' && phase !== 'done') {
    return { foundSessionId: undefined, outcome: undefined };
  }
  return { foundSessionId: sessionId, outcome: { kind: 'resolved', sessionId, created: false } };
}

export async function findTerminalStage(
  target: SessionTargetWorker,
  deps: SessionResolutionDeps
): Promise<{ foundSessionId: string | undefined; outcome: EnsureSessionOutcome | undefined }> {
  const found = await findStage(target, deps);
  if (found.outcome !== undefined) {
    return found;
  }
  if (deps.readWorkerTaskPhase(target.taskId) !== 'done') {
    return { foundSessionId: undefined, outcome: await ensureWorkerSession(target, deps) };
  }
  return {
    foundSessionId: undefined,
    outcome: { kind: 'unresolved', reason: 'task_terminal' },
  };
}

export function phaseStage(
  target: SessionTargetWorker,
  deps: SessionResolutionDeps
): {
  phase: WorkerTaskPhase;
  outcome: EnsureSessionOutcome | undefined;
  findArm: typeof findStage | undefined;
  postApprovalArm: typeof postApprovalStage | undefined;
  postApprovalDoneArm: typeof postApprovalDoneStage | undefined;
  routingArm: typeof awaitRoutingStage | undefined;
  activateArm: typeof activateStage | undefined;
} {
  const phase = deps.readWorkerTaskPhase(target.taskId);
  if (phase === 'terminal') {
    return {
      phase,
      outcome: { kind: 'unresolved', reason: 'task_terminal' },
      findArm: undefined,
      postApprovalArm: undefined,
      postApprovalDoneArm: undefined,
      routingArm: undefined,
      activateArm: undefined,
    };
  }
  if (phase === 'routing') {
    return {
      phase,
      outcome: undefined,
      findArm: undefined,
      postApprovalArm: undefined,
      postApprovalDoneArm: undefined,
      routingArm: awaitRoutingStage,
      activateArm: undefined,
    };
  }
  if (phase === 'post_approval') {
    return {
      phase,
      outcome: undefined,
      findArm: undefined,
      postApprovalArm: postApprovalStage,
      postApprovalDoneArm: undefined,
      routingArm: undefined,
      activateArm: undefined,
    };
  }
  if (phase === 'post_approval_done') {
    return {
      phase,
      outcome: undefined,
      findArm: undefined,
      postApprovalArm: undefined,
      postApprovalDoneArm: postApprovalDoneStage,
      routingArm: undefined,
      activateArm: undefined,
    };
  }
  if (phase === 'done') {
    return {
      phase,
      outcome: undefined,
      findArm: findTerminalStage,
      postApprovalArm: undefined,
      postApprovalDoneArm: undefined,
      routingArm: undefined,
      activateArm: undefined,
    };
  }
  return {
    phase,
    outcome: undefined,
    findArm: findStage,
    postApprovalArm: undefined,
    postApprovalDoneArm: undefined,
    routingArm: undefined,
    activateArm: activateStage,
  };
}

export async function postApprovalStage(
  target: SessionTargetWorker,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  const cap = delay(WORKER_SESSION_WAIT_CAP_MS);
  try {
    const worker = deps.getPostApprovalWorkerSession(target.taskId);
    if (worker !== null) {
      const nodeOk = !target.workflowNodeId || worker.nodeId === target.workflowNodeId;
      if (!nodeOk || worker.agentName !== target.agentName) {
        return { kind: 'unresolved', reason: 'post_approval_target_mismatch' };
      }
      const live = await Promise.race([deps.rehydrateSubSession(worker.sessionId), cap.promise]);
      if (cap.fired) {
        return { kind: 'unresolved', reason: 'restore_timeout' };
      }
      if (live !== null && deps.readWorkerTaskPhase(target.taskId) === 'post_approval') {
        const stillRouted = deps.getPostApprovalWorkerSession(target.taskId);
        if (stillRouted === null || stillRouted.sessionId !== worker.sessionId) {
          return ensureWorkerSession(target, deps);
        }
        return { kind: 'resolved', sessionId: worker.sessionId, created: false };
      }
    }
    if (deps.readWorkerTaskPhase(target.taskId) !== 'post_approval') {
      return ensureWorkerSession(target, deps);
    }
    const spawnedSessionId = await deps.spawnPostApprovalWorker(
      target.taskId,
      target.agentName,
      target.workflowNodeId ?? worker?.nodeId ?? undefined
    );
    if (deps.readWorkerTaskPhase(target.taskId) !== 'post_approval') {
      return ensureWorkerSession(target, deps);
    }
    if (spawnedSessionId === null) {
      return { kind: 'unresolved', reason: 'spawn_failed' };
    }
    return { kind: 'resolved', sessionId: spawnedSessionId, created: true };
  } finally {
    cap.cancel();
  }
}

export async function postApprovalDoneStage(
  target: SessionTargetWorker,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  const cap = delay(WORKER_SESSION_WAIT_CAP_MS);
  try {
    const worker = deps.getPostApprovalWorkerSession(target.taskId);
    if (worker !== null) {
      const nodeOk = !target.workflowNodeId || worker.nodeId === target.workflowNodeId;
      if (!nodeOk || worker.agentName !== target.agentName) {
        return { kind: 'unresolved', reason: 'post_approval_target_mismatch' };
      }
      const live = await Promise.race([deps.rehydrateSubSession(worker.sessionId), cap.promise]);
      if (cap.fired) {
        return { kind: 'unresolved', reason: 'restore_timeout' };
      }
      if (live !== null && deps.readWorkerTaskPhase(target.taskId) === 'post_approval_done') {
        const stillRouted = deps.getPostApprovalWorkerSession(target.taskId);
        if (stillRouted === null || stillRouted.sessionId !== worker.sessionId) {
          return ensureWorkerSession(target, deps);
        }
        return { kind: 'resolved', sessionId: worker.sessionId, created: false };
      }
    }
    if (deps.readWorkerTaskPhase(target.taskId) !== 'post_approval_done') {
      return ensureWorkerSession(target, deps);
    }
    return { kind: 'unresolved', reason: 'task_terminal' };
  } finally {
    cap.cancel();
  }
}

export async function awaitRoutingStage(
  target: SessionTargetWorker,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  const cap = delay(WORKER_SESSION_WAIT_CAP_MS);
  try {
    for (;;) {
      if (cap.fired) {
        return { kind: 'unresolved', reason: 'post_approval_pending' };
      }
      if (deps.readWorkerTaskPhase(target.taskId) !== 'routing') {
        return ensureWorkerSession(target, deps);
      }
      const worker = deps.getPostApprovalWorkerSession(target.taskId);
      if (worker !== null) {
        const nodeOk = !target.workflowNodeId || worker.nodeId === target.workflowNodeId;
        if (!nodeOk || worker.agentName !== target.agentName) {
          return { kind: 'unresolved', reason: 'post_approval_target_mismatch' };
        }
        const live = await Promise.race([deps.rehydrateSubSession(worker.sessionId), cap.promise]);
        if (cap.fired) {
          return { kind: 'unresolved', reason: 'post_approval_pending' };
        }
        if (live !== null && deps.readWorkerTaskPhase(target.taskId) === 'routing') {
          return { kind: 'resolved', sessionId: worker.sessionId, created: false };
        }
      }
      const tick = delay(WORKER_SESSION_POLL_INTERVAL_MS);
      await Promise.race([tick.promise, cap.promise]);
      tick.cancel();
    }
  } finally {
    cap.cancel();
  }
}

export async function activateStage(
  target: SessionTargetWorker,
  deps: SessionResolutionDeps
): Promise<{ activated: boolean; outcome: EnsureSessionOutcome | undefined }> {
  if (deps.readWorkerTaskPhase(target.taskId) !== 'run_active') {
    return { activated: false, outcome: await ensureWorkerSession(target, deps) };
  }
  const activated = await deps.activateTaskAgent(target);
  if (deps.readWorkerTaskPhase(target.taskId) !== 'run_active') {
    return { activated, outcome: await ensureWorkerSession(target, deps) };
  }
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
      if (deps.readWorkerTaskPhase(target.taskId) !== 'run_active') {
        return ensureWorkerSession(target, deps);
      }
      const sessionId = newestWorkerSessionId(deps.listWorkerExecutions(target));
      if (sessionId !== null) {
        const live = await Promise.race([deps.rehydrateSubSession(sessionId), cap.promise]);
        if (cap.fired) {
          return { kind: 'unresolved', reason: 'activation_timeout' };
        }
        if (live !== null) {
          if (deps.readWorkerTaskPhase(target.taskId) !== 'run_active') {
            return ensureWorkerSession(target, deps);
          }
          return { kind: 'resolved', sessionId, created: true };
        }
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
  .pipe(
    phaseStage,
    ['target', 'deps'],
    [
      'phase',
      'outcome',
      'findArm',
      'postApprovalArm',
      'postApprovalDoneArm',
      'routingArm',
      'activateArm',
    ]
  )
  .pipe('!settled', 'outcome')
  .pipe('?findArm', ['target', 'deps'], ['foundSessionId', 'outcome'])
  .pipe('!settled', 'outcome')
  .pipe('?postApprovalArm', ['target', 'deps'], 'outcome')
  .pipe('!settled', 'outcome')
  .pipe('?postApprovalDoneArm', ['target', 'deps'], 'outcome')
  .pipe('!settled', 'outcome')
  .pipe('?routingArm', ['target', 'deps'], 'outcome')
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
