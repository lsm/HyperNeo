import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

export type PostApprovalRecoveryAdmissionReason =
  | 'task-not-eligible'
  | 'retry-cadence-pending'
  | 'recovery-in-flight'
  | 'dispatch-claim-leased'
  | 'worker-revived'
  | 'orphan-adopted'
  | 'recovery-await-timeout';

export type PostApprovalRecoveryAdmissionGate =
  | { value: null }
  | { reason: PostApprovalRecoveryAdmissionReason };

export type PostApprovalRecoveryAdmissionResult =
  | { value: { action: 'redispatch'; task: SpaceTask } }
  | { reason: PostApprovalRecoveryAdmissionReason };

export interface PostApprovalRecoveryAdmissionDeps {
  isDispatchDead(task: SpaceTask): boolean;
  isUnrecordedStale(task: SpaceTask): boolean;
  cadencePending(taskId: string, now: number): boolean;
  markCadence(taskId: string, now: number): void;
  recoveryInFlight(task: SpaceTask, generation: number): boolean;
  hasLeasedClaim(task: SpaceTask): boolean;
  isReviveBypassed(task: SpaceTask, generation: number): boolean;
  adoptBypassed(task: SpaceTask, generation: number): boolean;
  revive(
    task: SpaceTask,
    generation: number,
    awaitBudgetMs?: number
  ): Promise<'revived' | 'skip' | 'replace' | 'timeout'>;
  adopt(task: SpaceTask, generation: number, awaitBudgetMs?: number): Promise<boolean | 'timeout'>;
  clearBypass(taskId: string): void;
}

export interface PostApprovalRecoveryFacts {
  dispatchDead: boolean;
  unrecordedStale: boolean;
  reviveBypassed: boolean;
}

export function loadAdmissionFacts(
  deps: PostApprovalRecoveryAdmissionDeps,
  task: SpaceTask,
  generation: number
): PostApprovalRecoveryFacts {
  return {
    dispatchDead: deps.isDispatchDead(task),
    unrecordedStale: deps.isUnrecordedStale(task),
    reviveBypassed: deps.isReviveBypassed(task, generation),
  };
}

function admitted(): PostApprovalRecoveryAdmissionGate {
  return { value: null };
}

function rejected(reason: PostApprovalRecoveryAdmissionReason): PostApprovalRecoveryAdmissionGate {
  return { reason };
}

export function gateTaskEligibility(
  deps: PostApprovalRecoveryAdmissionDeps,
  task: SpaceTask,
  generation: number,
  facts: PostApprovalRecoveryFacts,
  now: number
): PostApprovalRecoveryAdmissionGate {
  if (!facts.dispatchDead && !task.postApprovalBlockedReason && !facts.unrecordedStale) {
    return rejected('task-not-eligible');
  }
  if (deps.cadencePending(task.id, now)) {
    return rejected('retry-cadence-pending');
  }
  deps.markCadence(task.id, now);
  if (deps.recoveryInFlight(task, generation)) {
    return rejected('recovery-in-flight');
  }
  if (deps.hasLeasedClaim(task)) {
    return rejected('dispatch-claim-leased');
  }
  return admitted();
}

export async function attemptWorkerRevival(
  deps: PostApprovalRecoveryAdmissionDeps,
  task: SpaceTask,
  generation: number,
  facts: PostApprovalRecoveryFacts,
  scanDeadline: number
): Promise<PostApprovalRecoveryAdmissionGate> {
  if (!facts.dispatchDead || facts.reviveBypassed) return admitted();
  const outcome = await deps.revive(task, generation, Math.max(1_000, scanDeadline - Date.now()));
  if (outcome === 'timeout') return rejected('recovery-await-timeout');
  if (outcome !== 'replace') return rejected('worker-revived');
  return admitted();
}

export async function attemptOrphanAdoption(
  deps: PostApprovalRecoveryAdmissionDeps,
  task: SpaceTask,
  generation: number,
  scanDeadline: number
): Promise<PostApprovalRecoveryAdmissionGate> {
  if (task.postApprovalSessionId) return admitted();
  if (deps.adoptBypassed(task, generation)) return admitted();
  const outcome = await deps.adopt(task, generation, Math.max(1_000, scanDeadline - Date.now()));
  if (outcome === 'timeout') return rejected('recovery-await-timeout');
  if (outcome === true) return rejected('orphan-adopted');
  return admitted();
}

const recoveryAdmissionRun = (
  superpipe<Record<string, never>>({})('post-approval-recovery-admission') as PipelineAPI
)
  .input(['deps', 'task', 'generation', 'now', 'scanDeadline'])
  .pipe(loadAdmissionFacts, ['deps', 'task', 'generation'], 'facts')
  .pipe(gateTaskEligibility, ['deps', 'task', 'generation', 'facts', 'now'], 'result:rejection')
  .pipe(
    attemptWorkerRevival,
    ['deps', 'task', 'generation', 'facts', 'scanDeadline'],
    'result:rejection'
  )
  .pipe(attemptOrphanAdoption, ['deps', 'task', 'generation', 'scanDeadline'], 'result:rejection')
  .endAsync('rejection');

export async function runPostApprovalRecoveryAdmission(
  input: PostApprovalRecoveryAdmissionDeps & {
    task: SpaceTask;
    generation: number;
    now: number;
    scanDeadline: number;
  }
): Promise<PostApprovalRecoveryAdmissionResult> {
  const rejection = (await recoveryAdmissionRun(
    input,
    input.task,
    input.generation,
    input.now,
    input.scanDeadline
  )) as PostApprovalRecoveryAdmissionReason | null;
  if (rejection !== null && rejection !== undefined) {
    return { reason: rejection };
  }
  input.clearBypass(input.task.id);
  return { value: { action: 'redispatch', task: input.task } };
}
