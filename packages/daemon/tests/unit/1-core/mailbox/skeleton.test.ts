import { describe, expect, test } from 'bun:test';
import type { MailboxDeliveryOutcome } from '../../../../src/lib/mailbox/delivery';
import { MAILBOX_LANE, type MailboxEnqueueOutcome } from '../../../../src/lib/mailbox/enqueue';
import type { MailboxHandoffOutcome } from '../../../../src/lib/mailbox/handoff';
import type { MailboxSettleOutcome } from '../../../../src/lib/mailbox/settlement';

describe('mailbox skeleton stubs', () => {
  test('MAILBOX_LANE equals "mailbox"', () => {
    expect(MAILBOX_LANE).toBe('mailbox');
  });
});

describe('mailbox type assignment tests', () => {
  test('new outcome and resolution types accept their literal shapes', () => {
    const enqueued: MailboxEnqueueOutcome = { kind: 'enqueued', id: '1' };
    const enqueueRejected: MailboxEnqueueOutcome = { kind: 'rejected', reason: 'x' };
    const handoffOk: MailboxHandoffOutcome = { kind: 'enqueued', id: '1' };
    const handoffRejected: MailboxHandoffOutcome = { kind: 'rejected', reason: 'x' };
    const delivered: MailboxDeliveryOutcome = {
      entryId: '1',
      sessionId: 's',
      terminal: 'delivered',
      reason: null,
      settledAt: 1,
    };
    const failed: MailboxDeliveryOutcome = { kind: 'failed', reason: 'x' };
    const consumed: MailboxSettleOutcome = { kind: 'consumed' };
    const requeued: MailboxSettleOutcome = { kind: 'requeued', attempt: 1 };
    const dead: MailboxSettleOutcome = { kind: 'dead', reason: 'x' };

    expect([
      enqueued,
      enqueueRejected,
      handoffOk,
      handoffRejected,
      delivered,
      failed,
      consumed,
      requeued,
      dead,
    ]).toHaveLength(9);
  });
});
