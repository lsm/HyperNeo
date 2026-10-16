import { describe, expect, test } from 'bun:test';
import { MAILBOX_LANE, type MailboxEnqueueOutcome } from '../../../../src/lib/mailbox/enqueue';
import type { MailboxHandoffOutcome } from '../../../../src/lib/mailbox/handoff';

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

    expect([enqueued, enqueueRejected, handoffOk, handoffRejected]).toHaveLength(4);
  });
});
