import { describe, expect, test } from 'bun:test';
import { mapPendingAgentRowToMailboxEntry } from '../../../../src/lib/mailbox/bridge';
import {
  deliverMailboxEntry,
  type MailboxDeliveryOutcome,
} from '../../../../src/lib/mailbox/delivery';
import { MAILBOX_LANE, type MailboxEnqueueOutcome } from '../../../../src/lib/mailbox/enqueue';
import {
  DEFAULT_MAILBOX_ENTRY_POLICY,
  type MailboxEntry,
  type MailboxMessage,
} from '../../../../src/lib/mailbox/entry';
import type { MailboxHandoffOutcome } from '../../../../src/lib/mailbox/handoff';
import {
  type MailboxAddressResolution,
  resolveMailboxAddress,
} from '../../../../src/lib/mailbox/resolution';
import {
  expireMailboxEntries,
  type MailboxSettleOutcome,
  settleMailboxEntry,
} from '../../../../src/lib/mailbox/settlement';
import {
  findOrSpawnSessionForAddress,
  type MailboxSessionRef,
} from '../../../../src/lib/mailbox/spawn';
import type { PendingAgentMessageRecord } from '../../../../src/storage/repositories/pending-agent-message-repository';

const message: MailboxMessage = {
  type: 'user',
  message: { content: 'hello' },
  parent_tool_use_id: null,
};

const entry: MailboxEntry = {
  id: '00000000000000000000000000',
  to: { kind: 'session', sessionId: 'sess-1' },
  origin: 'test',
  message,
  status: 'enqueued',
  policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY },
};

const pendingRow = {} as PendingAgentMessageRecord;

describe('mailbox skeleton stubs', () => {
  test('MAILBOX_LANE equals "mailbox"', () => {
    expect(MAILBOX_LANE).toBe('mailbox');
  });

  test('resolveMailboxAddress throws its not implemented message', () => {
    expect(() => resolveMailboxAddress({ kind: 'session', sessionId: 'sess-1' })).toThrow(
      'mailbox: resolveMailboxAddress not implemented'
    );
  });

  test('findOrSpawnSessionForAddress throws its not implemented message', () => {
    expect(() => findOrSpawnSessionForAddress({ kind: 'session', sessionId: 'sess-1' })).toThrow(
      'mailbox: findOrSpawnSessionForAddress not implemented'
    );
  });

  test('deliverMailboxEntry throws its not implemented message', () => {
    expect(() => deliverMailboxEntry(entry)).toThrow(
      'mailbox: deliverMailboxEntry not implemented'
    );
  });

  test('settleMailboxEntry throws its not implemented message', () => {
    expect(() => settleMailboxEntry(entry, { kind: 'delivered', sessionId: 'sess-1' })).toThrow(
      'mailbox: settleMailboxEntry not implemented'
    );
  });

  test('expireMailboxEntries throws its not implemented message', () => {
    expect(() => expireMailboxEntries()).toThrow('mailbox: expireMailboxEntries not implemented');
  });

  test('mapPendingAgentRowToMailboxEntry throws its not implemented message', () => {
    expect(() => mapPendingAgentRowToMailboxEntry(pendingRow)).toThrow(
      'mailbox: mapPendingAgentRowToMailboxEntry not implemented'
    );
  });
});

describe('mailbox type assignment tests', () => {
  test('new outcome and resolution types accept their literal shapes', () => {
    const enqueued: MailboxEnqueueOutcome = { kind: 'enqueued', id: '1' };
    const enqueueRejected: MailboxEnqueueOutcome = { kind: 'rejected', reason: 'x' };
    const handoffOk: MailboxHandoffOutcome = { kind: 'enqueued', id: '1' };
    const handoffRejected: MailboxHandoffOutcome = { kind: 'rejected', reason: 'x' };
    const sessionResolution: MailboxAddressResolution = { kind: 'session', sessionId: 's' };
    const agentResolution: MailboxAddressResolution = {
      kind: 'agent',
      spaceId: 'sp',
      handle: 'h',
    };
    const sessionRef: MailboxSessionRef = { sessionId: 's', spawned: false };
    const delivered: MailboxDeliveryOutcome = { kind: 'delivered', sessionId: 's' };
    const deferred: MailboxDeliveryOutcome = { kind: 'deferred', reason: 'x' };
    const failed: MailboxDeliveryOutcome = { kind: 'failed', reason: 'x' };
    const consumed: MailboxSettleOutcome = { kind: 'consumed' };
    const requeued: MailboxSettleOutcome = { kind: 'requeued', attempt: 1 };
    const dead: MailboxSettleOutcome = { kind: 'dead', reason: 'x' };

    expect([
      enqueued,
      enqueueRejected,
      handoffOk,
      handoffRejected,
      sessionResolution,
      agentResolution,
      sessionRef,
      delivered,
      deferred,
      failed,
      consumed,
      requeued,
      dead,
    ]).toHaveLength(13);
  });
});
