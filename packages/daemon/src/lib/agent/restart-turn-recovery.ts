import superpipe, { type PipelineAPI } from 'superpipe';

export const RESTART_RECOVERY_NOTE =
  'The daemon restarted while you were working on the request above, so that turn was cut off. Your earlier tool results are real. Continue from where you left off without repeating steps that already finished.';

export interface RestartRecoveryEvidence {
  promptUuid: string;
  workedAfter: boolean;
}

export interface RestartRecoveryDeps {
  readEvidence(sessionId: string): RestartRecoveryEvidence | null;
  hasActiveDelivery(sessionId: string, uuid: string): boolean;
  resend(sessionId: string, uuid: string, enqueueDelivery: boolean, runAt?: number): boolean;
  sendNote(sessionId: string, promptUuid: string, runAt?: number): Promise<boolean>;
}

export interface RestartCutTurn {
  sessionId: string;
  resumeAt: number;
}

export type RestartRecoveryPlan =
  | { kind: 'resend'; sessionId: string; uuid: string; enqueueDelivery: boolean; runAt?: number }
  | { kind: 'continue'; sessionId: string; promptUuid: string; runAt?: number }
  | { kind: 'skip'; sessionId: string; reason: 'no_prompt' };

export function planRestartRecovery(
  turn: RestartCutTurn,
  found: { evidence: RestartRecoveryEvidence | null; deliveryActive: boolean }
): RestartRecoveryPlan {
  const { sessionId } = turn;
  const { evidence, deliveryActive } = found;
  if (!evidence) return { kind: 'skip', sessionId, reason: 'no_prompt' };
  const runAt = turn.resumeAt > 0 ? { runAt: turn.resumeAt } : {};
  return evidence.workedAfter
    ? { kind: 'continue', sessionId, promptUuid: evidence.promptUuid, ...runAt }
    : {
        kind: 'resend',
        sessionId,
        uuid: evidence.promptUuid,
        enqueueDelivery: !deliveryActive,
        ...runAt,
      };
}

function readRecoveryEvidence(turn: RestartCutTurn, deps: RestartRecoveryDeps) {
  const evidence = deps.readEvidence(turn.sessionId);
  return {
    evidence,
    deliveryActive: evidence ? deps.hasActiveDelivery(turn.sessionId, evidence.promptUuid) : false,
  };
}

export type RestartRecoveryResult = RestartRecoveryPlan & { resumed: boolean };

async function applyRecoveryPlan(
  plan: RestartRecoveryPlan,
  deps: RestartRecoveryDeps
): Promise<RestartRecoveryResult> {
  if (plan.kind === 'resend')
    return {
      ...plan,
      resumed: deps.resend(plan.sessionId, plan.uuid, plan.enqueueDelivery, plan.runAt),
    };
  if (plan.kind === 'continue')
    return { ...plan, resumed: await deps.sendNote(plan.sessionId, plan.promptUuid, plan.runAt) };
  return { ...plan, resumed: false };
}

const recoverCutTurn = (superpipe({})('recover-restart-cut-turn') as PipelineAPI)
  .input(['turn', 'deps'])
  .pipe(readRecoveryEvidence, ['turn', 'deps'], 'found')
  .pipe(planRestartRecovery, ['turn', 'found'], 'plan')
  .pipe(applyRecoveryPlan, ['plan', 'deps'], 'result')
  .endAsync('result') as (
  turn: RestartCutTurn,
  deps: RestartRecoveryDeps
) => Promise<RestartRecoveryResult>;

export async function recoverRestartCutTurns(
  turns: readonly RestartCutTurn[],
  deps: RestartRecoveryDeps
): Promise<RestartRecoveryResult[]> {
  const results: RestartRecoveryResult[] = [];
  for (const turn of turns) results.push(await recoverCutTurn(turn, deps));
  return results;
}
