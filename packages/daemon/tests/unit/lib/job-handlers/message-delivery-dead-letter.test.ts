import { describe, it, expect, mock } from 'bun:test';
import {
  DEAD_LETTER_SESSION_ERROR,
  settleMessageDeliveryDeadLetter,
  type MessageDeliveryDeadLetterSettlement,
} from '../../../../src/lib/job-handlers/message-delivery-dead-letter';
import {
  asMessageDeliveryPayload,
  type MessageDeliveryPayload,
} from '../../../../src/lib/agent/message-delivery';

function recordingSettlement(markFailedResult: string | null = 'db-1'): {
  settlement: MessageDeliveryDeadLetterSettlement;
  calls: string[];
} {
  const calls: string[] = [];
  const settlement: MessageDeliveryDeadLetterSettlement = {
    markDeliveryFailedByUuid: mock(() => {
      calls.push('markFailed');
      return markFailedResult;
    }),
    publishStatusChanged: mock(async () => {
      calls.push('statusChanged');
    }),
    publishSessionError: mock(async () => {
      calls.push('sessionError');
    }),
    settleSkippedDelivery: mock(async () => {
      calls.push('settle');
    }),
  };
  return { settlement, calls };
}

const SPACE_INJECT_PAYLOAD: MessageDeliveryPayload = {
  sessionId: 'sess-1',
  messageUuid: 'uuid-1',
  origin: 'space_inject',
  parentToolUseId: null,
};

const CHAT_PAYLOAD: MessageDeliveryPayload = {
  sessionId: 'sess-1',
  messageUuid: 'uuid-2',
  origin: 'chat',
  parentToolUseId: null,
};

const MID_TURN_INJECT_PAYLOAD: MessageDeliveryPayload = {
  sessionId: 'sess-1',
  messageUuid: 'uuid-3',
  origin: 'space_inject',
  parentToolUseId: null,
  injectedMidTurn: true,
};

describe('settleMessageDeliveryDeadLetter (onDead → session.error → settle ordering)', () => {
  it('for a space_inject delivery, publishes session.error BEFORE settling the queued marker', async () => {
    const { settlement, calls } = recordingSettlement();
    await settleMessageDeliveryDeadLetter(SPACE_INJECT_PAYLOAD, settlement);

    const errorIndex = calls.indexOf('sessionError');
    const settleIndex = calls.indexOf('settle');
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(settleIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeLessThan(settleIndex);
    expect(settlement.publishSessionError).toHaveBeenCalledWith(
      'sess-1',
      DEAD_LETTER_SESSION_ERROR
    );
  });

  it('does NOT publish session.error for a mid-turn space_inject delivery (auxiliary handoff)', async () => {
    const { settlement, calls } = recordingSettlement();
    await settleMessageDeliveryDeadLetter(MID_TURN_INJECT_PAYLOAD, settlement);

    expect(settlement.publishSessionError).not.toHaveBeenCalled();
    expect(calls).not.toContain('sessionError');
    expect(calls).toContain('settle');
  });

  it('treats a legacy role-carrying steer payload as a mid-turn injection (upgrade drain)', async () => {
    const { settlement, calls } = recordingSettlement();
    const legacySteer: Record<string, unknown> = {
      sessionId: 'sess-1',
      messageUuid: 'uuid-legacy',
      role: 'steer',
      origin: 'space_inject',
      parentToolUseId: null,
    };
    const parsed = asMessageDeliveryPayload(legacySteer);
    expect(parsed?.injectedMidTurn).toBe(true);
    await settleMessageDeliveryDeadLetter(parsed!, settlement);

    expect(settlement.publishSessionError).not.toHaveBeenCalled();
    expect(calls).not.toContain('sessionError');
    expect(calls).toContain('settle');
  });

  it('still publishes session.error for a space_inject kickoff that dead-letters while its query hangs', async () => {
    const { settlement, calls } = recordingSettlement();
    await settleMessageDeliveryDeadLetter(SPACE_INJECT_PAYLOAD, settlement);

    expect(settlement.publishSessionError).toHaveBeenCalledWith(
      'sess-1',
      DEAD_LETTER_SESSION_ERROR
    );
    expect(calls).toContain('sessionError');
  });

  it('for a non-space_inject delivery, does NOT publish session.error (only mark + status + settle)', async () => {
    const { settlement, calls } = recordingSettlement();
    await settleMessageDeliveryDeadLetter(CHAT_PAYLOAD, settlement);

    expect(calls).not.toContain('sessionError');
    expect(settlement.publishSessionError).not.toHaveBeenCalled();
    expect(calls).toContain('settle');
  });

  it('terminalizes the row + broadcasts the status flip before settling', async () => {
    const { settlement, calls } = recordingSettlement('db-flip');
    await settleMessageDeliveryDeadLetter(SPACE_INJECT_PAYLOAD, settlement);

    expect(settlement.markDeliveryFailedByUuid).toHaveBeenCalledWith('sess-1', 'uuid-1');
    expect(settlement.publishStatusChanged).toHaveBeenCalledWith('sess-1', ['db-flip']);
    expect(calls).toEqual(['markFailed', 'statusChanged', 'sessionError', 'settle']);
  });

  it('still settles when the row was already terminal (markFailed returns null — no status broadcast)', async () => {
    const { settlement, calls } = recordingSettlement(null);
    await settleMessageDeliveryDeadLetter(SPACE_INJECT_PAYLOAD, settlement);

    expect(settlement.publishStatusChanged).not.toHaveBeenCalled();
    expect(calls).toEqual(['markFailed', 'sessionError', 'settle']);
  });

  it('resets a stuck processing state for the dead-lettered message before settling', async () => {
    const { settlement, calls } = recordingSettlement();
    settlement.resetStuckProcessingState = mock(async () => {
      calls.push('resetStuck');
    });
    await settleMessageDeliveryDeadLetter(CHAT_PAYLOAD, settlement);

    expect(settlement.resetStuckProcessingState).toHaveBeenCalledWith('sess-1', 'uuid-2');
    const resetIndex = calls.indexOf('resetStuck');
    const settleIndex = calls.indexOf('settle');
    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(resetIndex).toBeLessThan(settleIndex);
  });

  it('still settles when the stuck-state reset hook throws', async () => {
    const { settlement, calls } = recordingSettlement();
    settlement.resetStuckProcessingState = mock(async () => {
      calls.push('resetStuck');
      throw new Error('reset exploded');
    });
    await settleMessageDeliveryDeadLetter(CHAT_PAYLOAD, settlement);

    expect(calls).toEqual(['markFailed', 'statusChanged', 'resetStuck', 'settle']);
  });
});
