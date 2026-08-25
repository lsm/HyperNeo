import { describe, it, expect, mock } from 'bun:test';
import {
  DEAD_LETTER_SESSION_ERROR,
  settleMessageDeliveryDeadLetter,
  type MessageDeliveryDeadLetterSettlement,
} from '../../../../src/lib/job-handlers/message-delivery-dead-letter';
import type { MessageDeliveryPayload } from '../../../../src/lib/agent/message-delivery';

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
  role: 'turn',
  origin: 'space_inject',
  parentToolUseId: null,
};

const CHAT_PAYLOAD: MessageDeliveryPayload = {
  sessionId: 'sess-1',
  messageUuid: 'uuid-2',
  role: 'turn',
  origin: 'chat',
  parentToolUseId: null,
};

const SPACE_INJECT_STEER_PAYLOAD: MessageDeliveryPayload = {
  sessionId: 'sess-1',
  messageUuid: 'uuid-3',
  role: 'steer',
  origin: 'space_inject',
  parentToolUseId: null,
};

describe('settleMessageDeliveryDeadLetter (onDead → session.error → settle ordering)', () => {
  it('for a space_inject kickoff, publishes session.error BEFORE settling the queued marker', async () => {
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

  it('for a non-space_inject delivery, does NOT publish session.error (only mark + status + settle)', async () => {
    const { settlement, calls } = recordingSettlement();
    await settleMessageDeliveryDeadLetter(CHAT_PAYLOAD, settlement);

    expect(calls).not.toContain('sessionError');
    expect(settlement.publishSessionError).not.toHaveBeenCalled();
    expect(calls).toContain('settle');
  });

  it('does NOT publish session.error for a space_inject STEER (mid-turn handoff, not the kickoff)', async () => {
    const { settlement, calls } = recordingSettlement();
    await settleMessageDeliveryDeadLetter(SPACE_INJECT_STEER_PAYLOAD, settlement);

    expect(settlement.publishSessionError).not.toHaveBeenCalled();
    expect(calls).not.toContain('sessionError');
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

  it('terminalizes every batch member alongside the kickoff (batch-aware)', async () => {
    const { settlement } = recordingSettlement('db-flip');
    const payload: MessageDeliveryPayload = {
      ...CHAT_PAYLOAD,
      batchUuids: ['uuid-2', 'member-a', 'member-b'],
    };
    await settleMessageDeliveryDeadLetter(payload, settlement);

    expect(settlement.markDeliveryFailedByUuid).toHaveBeenCalledWith('sess-1', 'uuid-2');
    expect(settlement.markDeliveryFailedByUuid).toHaveBeenCalledWith('sess-1', 'member-a');
    expect(settlement.markDeliveryFailedByUuid).toHaveBeenCalledWith('sess-1', 'member-b');
    expect(settlement.publishStatusChanged).toHaveBeenCalledWith('sess-1', [
      'db-flip',
      'db-flip',
      'db-flip',
    ]);
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
