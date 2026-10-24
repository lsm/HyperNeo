import superpipe, { type PipelineAPI } from 'superpipe';

export const RESTART_RECOVERY_PREFIX = 'restart-recovery:';

export const RESTART_RECOVERY_NOTE =
  'The daemon restarted while you were working on the request above, so that turn was cut off. Your earlier tool results are real. Continue from where you left off without repeating steps that already finished.';

export interface RestartRecoveryEvidence {
  promptUuid: string;
  workedAfter: boolean;
}

export interface RestartRecoveryDeps {
  readEvidence(
    sessionId: string
  ): RestartRecoveryEvidence | null | Promise<RestartRecoveryEvidence | null>;
  hasActiveDelivery(sessionId: string, uuid: string): boolean;
  resend(sessionId: string, uuid: string, enqueueDelivery: boolean): boolean;
  sendNote(sessionId: string, promptUuid: string): Promise<boolean>;
}

export type RestartRecoveryPlan =
  | { kind: 'resend'; sessionId: string; uuid: string; enqueueDelivery: boolean }
  | { kind: 'continue'; sessionId: string; promptUuid: string }
  | { kind: 'skip'; sessionId: string; reason: 'no_prompt' };

export function planRestartRecovery(
  sessionId: string,
  found: { evidence: RestartRecoveryEvidence | null; deliveryActive: boolean }
): RestartRecoveryPlan {
  const { evidence, deliveryActive } = found;
  if (!evidence) return { kind: 'skip', sessionId, reason: 'no_prompt' };
  return evidence.workedAfter
    ? { kind: 'continue', sessionId, promptUuid: evidence.promptUuid }
    : {
        kind: 'resend',
        sessionId,
        uuid: evidence.promptUuid,
        enqueueDelivery: !deliveryActive,
      };
}

async function readRecoveryEvidence(sessionId: string, deps: RestartRecoveryDeps) {
  const evidence = await deps.readEvidence(sessionId);
  return {
    evidence,
    deliveryActive: evidence ? deps.hasActiveDelivery(sessionId, evidence.promptUuid) : false,
  };
}

export type RestartRecoveryResult = RestartRecoveryPlan & { resumed: boolean };

async function applyRecoveryPlan(
  plan: RestartRecoveryPlan,
  deps: RestartRecoveryDeps
): Promise<RestartRecoveryResult> {
  if (plan.kind === 'resend')
    return { ...plan, resumed: deps.resend(plan.sessionId, plan.uuid, plan.enqueueDelivery) };
  if (plan.kind === 'continue')
    return { ...plan, resumed: await deps.sendNote(plan.sessionId, plan.promptUuid) };
  return { ...plan, resumed: false };
}

const recoverCutTurn = (superpipe({})('recover-restart-cut-turn') as PipelineAPI)
  .input(['sessionId', 'deps'])
  .pipe(readRecoveryEvidence, ['sessionId', 'deps'], 'found')
  .pipe(planRestartRecovery, ['sessionId', 'found'], 'plan')
  .pipe(applyRecoveryPlan, ['plan', 'deps'], 'result')
  .endAsync('result') as (
  sessionId: string,
  deps: RestartRecoveryDeps
) => Promise<RestartRecoveryResult>;

export async function recoverRestartCutTurns(
  sessionIds: readonly string[],
  deps: RestartRecoveryDeps
): Promise<RestartRecoveryResult[]> {
  const results: RestartRecoveryResult[] = [];
  for (const sessionId of sessionIds) results.push(await recoverCutTurn(sessionId, deps));
  return results;
}
