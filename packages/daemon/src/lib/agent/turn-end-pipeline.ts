import { decisionRun } from '../space/runtime/decision-pipeline.ts';
import { isTurnEndAckEligible } from './ack-selection.ts';
import type { TurnEndEvent, TurnEndFlags, TurnEndPlan } from './turn-end-routing.ts';
import { routeTurnEnd } from './turn-end-routing.ts';
import type { ResultUsage, UsageAccountingState } from './usage-accounting.ts';
import { recordResultUsage } from './usage-accounting.ts';

export type TurnEndAckRow = {
  uuid: string;
  durableOwned: boolean;
  yielded: boolean;
  pendingOrClaimed: boolean;
};

export type TurnEndAckSelection = { messageId: string; deliveryUuids: string[] };

export interface TurnEndPipelineDecision {
  usage: UsageAccountingState;
  ackSelection: TurnEndAckSelection[];
  plan: TurnEndPlan;
}

interface TurnEndPipelineCtx {
  flags: TurnEndFlags;
  event: TurnEndEvent;
  queryMode: 'immediate' | 'manual';
  usageState: UsageAccountingState;
  resultUsage: ResultUsage | null;
  acknowledgedPersistedUserThisTurn: boolean;
  activeMessageId: string | null;
  ackRows: ReadonlyArray<TurnEndAckRow>;
  usage: UsageAccountingState | null;
  ackSelection: TurnEndAckSelection[] | null;
  plan: TurnEndPlan | null;
  decision: TurnEndPipelineDecision | null;
}

export type TurnEndPipelineInput = Omit<
  TurnEndPipelineCtx,
  'decision' | 'usage' | 'ackSelection' | 'plan'
>;

function applyUsageAccountingGate(ctx: TurnEndPipelineCtx): TurnEndPipelineCtx {
  const result = ctx.event.kind === 'result' ? ctx.event.result : null;
  const accountUsage =
    result?.isTopLevel === true &&
    (result.isLimitRecoveryEngaged === true ||
      (result.isSuccess && result.isLimitRecoveryEngaged === false));
  if (ctx.resultUsage === null || !accountUsage) {
    return { ...ctx, usage: ctx.usageState };
  }
  return { ...ctx, usage: recordResultUsage(ctx.usageState, ctx.resultUsage) };
}

export function selectTurnEndAckRow(
  row: TurnEndAckRow,
  activeMessageId: string | null
): TurnEndAckSelection | null {
  if (
    !isTurnEndAckEligible({
      uuid: row.uuid,
      activeMessageId,
      durableOwned: row.durableOwned,
      yielded: row.yielded,
      pendingOrClaimed: row.pendingOrClaimed,
    })
  ) {
    return null;
  }
  return {
    messageId: row.uuid,
    deliveryUuids: [row.uuid],
  };
}

function applyAckSelectionGate(ctx: TurnEndPipelineCtx): TurnEndPipelineCtx {
  const result = ctx.event.kind === 'result' ? ctx.event.result : null;
  const admitted =
    result?.isTopLevel === true &&
    result.isSuccess &&
    result.isLimitRecoveryEngaged === false &&
    !ctx.acknowledgedPersistedUserThisTurn &&
    !ctx.flags.suppressIdleOnNextResult;
  if (!admitted) {
    return { ...ctx, ackSelection: [] };
  }
  const ackSelection = ctx.ackRows
    .map((row) => selectTurnEndAckRow(row, ctx.activeMessageId))
    .filter((selection): selection is TurnEndAckSelection => selection !== null);
  return { ...ctx, ackSelection };
}

function applyTurnEndRoutingGate(ctx: TurnEndPipelineCtx): TurnEndPipelineCtx {
  return { ...ctx, plan: routeTurnEnd(ctx.flags, ctx.event, { queryMode: ctx.queryMode }) };
}

function applyFinalGate(ctx: TurnEndPipelineCtx): TurnEndPipelineCtx {
  const plan = ctx.plan ?? routeTurnEnd(ctx.flags, ctx.event, { queryMode: ctx.queryMode });
  return {
    ...ctx,
    decision: {
      usage: ctx.usage ?? ctx.usageState,
      ackSelection: ctx.ackSelection ?? [],
      plan,
    },
  };
}

const turnEndPipelineRun = decisionRun('sdk-turn-end', [
  applyUsageAccountingGate,
  applyAckSelectionGate,
  applyTurnEndRoutingGate,
  applyFinalGate,
]);

export function decideTurnEnd(input: TurnEndPipelineInput): TurnEndPipelineDecision {
  const ctx = turnEndPipelineRun({
    ...input,
    usage: null,
    ackSelection: null,
    plan: null,
  });
  return (
    ctx.decision ?? {
      usage: ctx.usage ?? ctx.usageState,
      ackSelection: ctx.ackSelection ?? [],
      plan: routeTurnEnd(ctx.flags, ctx.event, { queryMode: ctx.queryMode }),
    }
  );
}
