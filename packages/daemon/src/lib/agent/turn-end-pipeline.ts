import superpipe, { type PipelineAPI } from 'superpipe';
import { isTurnEndAckEligible } from './ack-selection.ts';
import type {
  TurnEndEvent,
  TurnEndFlags,
  TurnEndPlan,
  TurnEndResultEvent,
} from './turn-end-routing.ts';
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

export interface TurnEndPipelineInput {
  flags: TurnEndFlags;
  event: TurnEndEvent;
  queryMode: 'immediate' | 'manual';
  usageState: UsageAccountingState;
  resultUsage: ResultUsage | null;
  acknowledgedPersistedUserThisTurn: boolean;
  activeMessageId: string | null;
  ackRows: ReadonlyArray<TurnEndAckRow>;
}

interface TurnEndUsage {
  usage: UsageAccountingState;
  result: TurnEndResultEvent | null;
}

function resolveTurnEndUsage(input: TurnEndPipelineInput): TurnEndUsage {
  const result = input.event.kind === 'result' ? input.event.result : null;
  const accountUsage =
    result?.isTopLevel === true &&
    (result.isLimitRecoveryEngaged === true ||
      (result.isSuccess && result.isLimitRecoveryEngaged === false));
  return {
    usage:
      input.resultUsage === null || !accountUsage
        ? input.usageState
        : recordResultUsage(input.usageState, input.resultUsage),
    result,
  };
}

export function selectTurnEndAcks(
  input: TurnEndPipelineInput,
  result: TurnEndResultEvent | null
): TurnEndAckSelection[] {
  const admitted =
    result?.isTopLevel === true &&
    result.isSuccess &&
    result.isLimitRecoveryEngaged === false &&
    !input.acknowledgedPersistedUserThisTurn &&
    !input.flags.suppressIdleOnTurnEnd;
  if (!admitted) return [];
  return input.ackRows
    .map((row) => selectTurnEndAckRow(row, input.activeMessageId))
    .filter((selection): selection is TurnEndAckSelection => selection !== null);
}

export const decideTurnEnd = (superpipe({})('sdk-turn-end') as PipelineAPI)
  .input(['input'])
  .pipe(resolveTurnEndUsage, 'input', 'usage')
  .pipe(
    (usage: TurnEndUsage, input: TurnEndPipelineInput): TurnEndPipelineDecision => ({
      usage: usage.usage,
      ackSelection: selectTurnEndAcks(input, usage.result),
      plan: routeTurnEnd(input.flags, input.event, { queryMode: input.queryMode }),
    }),
    ['usage', 'input'],
    'decision'
  )
  .end('decision') as (input: TurnEndPipelineInput) => TurnEndPipelineDecision;

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
