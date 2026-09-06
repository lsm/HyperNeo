import superpipe, { type PipelineAPI } from 'superpipe';
import type { MailboxHandoffOutcome } from '../../mailbox/handoff.ts';

export type MailboxSettlement =
  | { kind: 'materialized'; dbId: string }
  | { kind: 'dead' | 'absent' | 'cancelled' | 'stuck' };

export type MailboxInjectSettlementOutcome =
  | { action: 'delivered'; dbId: string }
  | { action: 'failed'; reason: string };

export type MailboxConsumptionOutcome = 'consumed' | 'inactive' | 'timeout';

export interface MailboxInjectSettlementDeps {
  normalizeExistingRow(sessionId: string, messageId: string): void;
  handoffToMailbox(): Promise<MailboxHandoffOutcome>;
  awaitSettlement(
    sessionId: string,
    messageId: string,
    entryId: string,
    rowExistedAtHandoff: boolean
  ): Promise<MailboxSettlement>;
  activateDeferredRow(sessionId: string, messageId: string): Promise<boolean>;
  hasSettledDelivery(sessionId: string, messageId: string): boolean;
  hasInFlightDelivery(sessionId: string, messageId: string): boolean;
  claimQueued(messageId: string): Promise<void>;
  awaitDeliveryConsumption(
    sessionId: string,
    messageId: string
  ): Promise<MailboxConsumptionOutcome>;
  persistFailedRow(sessionId: string, messageId: string): Promise<void>;
}

export interface MailboxInjectSettlementInput {
  sessionId: string;
  messageId: string;
  rowExistedAtHandoff: boolean;
  existingSendStatus: string | null;
  deps: MailboxInjectSettlementDeps;
}

export const isTerminalOutcome = (outcome?: MailboxInjectSettlementOutcome): boolean =>
  outcome !== undefined;

export function normalizeExistingRowStage(
  deps: MailboxInjectSettlementDeps,
  sessionId: string,
  messageId: string,
  existingSendStatus: string | null
): { normalized: boolean } {
  if (existingSendStatus !== null) {
    deps.normalizeExistingRow(sessionId, messageId);
  }
  return { normalized: existingSendStatus !== null };
}

export async function handoffStage(
  deps: MailboxInjectSettlementDeps,
  sessionId: string,
  messageId: string
): Promise<{
  handoff?: MailboxHandoffOutcome;
  finalOutcome?: MailboxInjectSettlementOutcome;
}> {
  const handoff = await deps.handoffToMailbox();
  if (handoff.kind === 'rejected') {
    await deps.persistFailedRow(sessionId, messageId);
    return {
      handoff: undefined,
      finalOutcome: {
        action: 'failed',
        reason: `mailbox handoff rejected: ${handoff.reason}`,
      },
    };
  }
  return { handoff, finalOutcome: undefined };
}

export async function settleStage(
  deps: MailboxInjectSettlementDeps,
  sessionId: string,
  messageId: string,
  handoff: MailboxHandoffOutcome | undefined,
  rowExistedAtHandoff: boolean
): Promise<{
  settlement?: MailboxSettlement;
  finalOutcome?: MailboxInjectSettlementOutcome;
}> {
  const entryId = handoff?.kind === 'enqueued' ? handoff.id : '';
  const settlement = await deps.awaitSettlement(sessionId, messageId, entryId, rowExistedAtHandoff);
  if (settlement.kind !== 'materialized') {
    await deps.persistFailedRow(sessionId, messageId);
    return {
      settlement,
      finalOutcome: {
        action: 'failed',
        reason: `mailbox entry failed to materialize (${settlement.kind})`,
      },
    };
  }
  return { settlement, finalOutcome: undefined };
}

export async function activateDeferredStage(
  deps: MailboxInjectSettlementDeps,
  sessionId: string,
  messageId: string,
  existingSendStatus: string | null
): Promise<{ activated: boolean; finalOutcome?: MailboxInjectSettlementOutcome }> {
  if (existingSendStatus !== 'deferred') {
    return { activated: false, finalOutcome: undefined };
  }
  const activated = await deps.activateDeferredRow(sessionId, messageId);
  if (
    activated ||
    deps.hasSettledDelivery(sessionId, messageId) ||
    deps.hasInFlightDelivery(sessionId, messageId)
  ) {
    return { activated, finalOutcome: undefined };
  }
  return {
    activated: false,
    finalOutcome: { action: 'failed', reason: 'deferred row activated nothing' },
  };
}

export async function claimQueuedStage(
  deps: MailboxInjectSettlementDeps,
  sessionId: string,
  messageId: string
): Promise<{ queued: boolean }> {
  if (!deps.hasInFlightDelivery(sessionId, messageId)) return { queued: false };
  try {
    await deps.claimQueued(messageId);
  } catch {}
  return { queued: true };
}

export async function consumeDeliveryStage(
  deps: MailboxInjectSettlementDeps,
  sessionId: string,
  messageId: string
): Promise<{ consumed: boolean; finalOutcome?: MailboxInjectSettlementOutcome }> {
  const outcome = await deps.awaitDeliveryConsumption(sessionId, messageId);
  if (outcome === 'consumed') return { consumed: true, finalOutcome: undefined };
  await deps.persistFailedRow(sessionId, messageId);
  return {
    consumed: false,
    finalOutcome: { action: 'failed', reason: `mailbox delivery not consumed (${outcome})` },
  };
}

export function deliverOutcomeStage(
  settlement: MailboxSettlement | undefined,
  messageId: string
): { finalOutcome: MailboxInjectSettlementOutcome } {
  return {
    finalOutcome: {
      action: 'delivered',
      dbId: settlement?.kind === 'materialized' ? settlement.dbId : messageId,
    },
  };
}

const runMailboxInjectSettlement = (
  superpipe<{ isTerminalOutcome: (outcome?: MailboxInjectSettlementOutcome) => boolean }>({
    isTerminalOutcome,
  })('mailbox-inject-settlement') as PipelineAPI
)
  .input(['sessionId', 'messageId', 'rowExistedAtHandoff', 'existingSendStatus', 'deps'])
  .pipe(
    normalizeExistingRowStage,
    ['deps', 'sessionId', 'messageId', 'existingSendStatus'],
    ['normalized']
  )
  .pipe(handoffStage, ['deps', 'sessionId', 'messageId'], ['handoff', 'finalOutcome'])
  .pipe('!isTerminalOutcome', 'finalOutcome')
  .pipe(
    settleStage,
    ['deps', 'sessionId', 'messageId', 'handoff', 'rowExistedAtHandoff'],
    ['settlement', 'finalOutcome']
  )
  .pipe('!isTerminalOutcome', 'finalOutcome')
  .pipe(
    activateDeferredStage,
    ['deps', 'sessionId', 'messageId', 'existingSendStatus'],
    ['activated', 'finalOutcome']
  )
  .pipe('!isTerminalOutcome', 'finalOutcome')
  .pipe(claimQueuedStage, ['deps', 'sessionId', 'messageId'], ['queued'])
  .pipe('!isTerminalOutcome', 'finalOutcome')
  .pipe(consumeDeliveryStage, ['deps', 'sessionId', 'messageId'], ['consumed', 'finalOutcome'])
  .pipe('!isTerminalOutcome', 'finalOutcome')
  .pipe(deliverOutcomeStage, ['settlement', 'messageId'], ['finalOutcome'])
  .endAsync('finalOutcome') as (
  sessionId: string,
  messageId: string,
  rowExistedAtHandoff: boolean,
  existingSendStatus: string | null,
  deps: MailboxInjectSettlementDeps
) => Promise<MailboxInjectSettlementOutcome | undefined>;

export async function settleMailboxInject(
  input: MailboxInjectSettlementInput
): Promise<MailboxInjectSettlementOutcome> {
  const outcome = await runMailboxInjectSettlement(
    input.sessionId,
    input.messageId,
    input.rowExistedAtHandoff,
    input.existingSendStatus,
    input.deps
  );
  return outcome ?? { action: 'failed', reason: 'mailbox settlement produced no outcome' };
}
