import { describe, it, expect, mock } from 'bun:test';
import {
  DEAD_LETTER_SESSION_ERROR,
  settleMessageDeliveryDeadLetter,
  type MessageDeliveryDeadLetterSettlement,
} from '../../../../src/lib/job-handlers/message-delivery-dead-letter';
import type { MessageDeliveryPayload } from '../../../../src/lib/agent/message-delivery';

/** A settlement that records the call order so the test can assert sequencing. */
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

describe('settleMessageDeliveryDeadLetter (onDead → session.error → settle ordering)', () => {
  it('for a space_inject kickoff, publishes session.error BEFORE settling the queued marker', async () => {
    // The settlement idle would let registerCompletionCallback read the
    // dead-letter as success; session.error (awaited first) fires the error
    // path so the execution is marked blocked instead. (Codex P1.)
    const { settlement, calls } = recordingSettlement();
    await settleMessageDeliveryDeadLetter(SPACE_INJECT_PAYLOAD, settlement);

    const errorIndex = calls.indexOf('sessionError');
    const settleIndex = calls.indexOf('settle');
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(settleIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeLessThan(settleIndex); // session.error strictly before settle
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

  it('terminalizes the row + broadcasts the status flip before settling', async () => {
    const { settlement, calls } = recordingSettlement('db-flip');
    await settleMessageDeliveryDeadLetter(SPACE_INJECT_PAYLOAD, settlement);

    expect(settlement.markDeliveryFailedByUuid).toHaveBeenCalledWith('sess-1', 'uuid-1');
    expect(settlement.publishStatusChanged).toHaveBeenCalledWith('sess-1', ['db-flip']);
    // markFailed → statusChanged → sessionError → settle
    expect(calls).toEqual(['markFailed', 'statusChanged', 'sessionError', 'settle']);
  });

  it('still settles when the row was already terminal (markFailed returns null — no status broadcast)', async () => {
    const { settlement, calls } = recordingSettlement(null);
    await settleMessageDeliveryDeadLetter(SPACE_INJECT_PAYLOAD, settlement);

    expect(settlement.publishStatusChanged).not.toHaveBeenCalled();
    expect(calls).toEqual(['markFailed', 'sessionError', 'settle']);
  });
});
