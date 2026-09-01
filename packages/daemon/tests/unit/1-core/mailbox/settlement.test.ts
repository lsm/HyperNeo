import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAILBOX_ENTRY_POLICY,
  type MailboxEntry,
  type MailboxMessage,
} from '../../../../src/lib/mailbox/entry';
import { settleMailboxEntry } from '../../../../src/lib/mailbox/settlement';

const message: MailboxMessage = {
  type: 'user',
  message: { content: 'hello' },
  parent_tool_use_id: null,
};

const SETTLED_AT = 1_726_000_000_000;

function makeEntry(overrides?: { id?: string; to?: MailboxEntry['to'] }): MailboxEntry {
  return {
    id: overrides?.id ?? '00000000000000000000000000',
    to: overrides?.to ?? { kind: 'session', sessionId: 'sess-1' },
    origin: 'test',
    message,
    status: 'enqueued',
    policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY },
  };
}

describe('settleMailboxEntry', () => {
  test('projects a delivered settlement with entry id and session id', () => {
    const entry = makeEntry({
      id: '00000000000000000000000001',
      to: { kind: 'session', sessionId: 'sess-9' },
    });

    expect(settleMailboxEntry(entry, 'delivered', SETTLED_AT)).toEqual({
      entryId: '00000000000000000000000001',
      sessionId: 'sess-9',
      terminal: 'delivered',
      reason: null,
      settledAt: SETTLED_AT,
    });
  });

  test('projects a dead settlement carrying its reason', () => {
    const entry = makeEntry();

    expect(settleMailboxEntry(entry, 'dead', SETTLED_AT, 'max attempts exceeded')).toEqual({
      entryId: entry.id,
      sessionId: 'sess-1',
      terminal: 'dead',
      reason: 'max attempts exceeded',
      settledAt: SETTLED_AT,
    });
  });

  test('omitted reason projects to null for both terminals', () => {
    const entry = makeEntry();

    expect(settleMailboxEntry(entry, 'dead', SETTLED_AT).reason).toBeNull();
    expect(settleMailboxEntry(entry, 'delivered', SETTLED_AT).reason).toBeNull();
  });

  test('explicit undefined reason projects to null', () => {
    const entry = makeEntry();

    expect(settleMailboxEntry(entry, 'dead', SETTLED_AT, undefined).reason).toBeNull();
  });

  test('agent-kind entry settles with a null session id but keeps its entry id', () => {
    const entry = makeEntry({
      id: '00000000000000000000000002',
      to: { kind: 'agent', spaceId: 'sp-1', handle: 'coder', taskId: '1752', node: 'Coding' },
    });
    const settlement = settleMailboxEntry(entry, 'dead', SETTLED_AT, 'corrupt target');

    expect(settlement.sessionId).toBeNull();
    expect(settlement.entryId).toBe('00000000000000000000000002');
    expect(settlement.terminal).toBe('dead');
  });

  test('fresh-literal law: mutating the entry after the call does not change the settlement', () => {
    const entry = makeEntry();
    const settlement = settleMailboxEntry(entry, 'delivered', SETTLED_AT);

    entry.id = '00000000000000000000000099';
    entry.to = { kind: 'agent', spaceId: 'sp-1', handle: 'coder' };

    expect(settlement).toEqual({
      entryId: '00000000000000000000000000',
      sessionId: 'sess-1',
      terminal: 'delivered',
      reason: null,
      settledAt: SETTLED_AT,
    });
  });

  test('returns a plain literal that shares no object references with the entry', () => {
    const entry = makeEntry();
    const settlement = settleMailboxEntry(entry, 'delivered', SETTLED_AT);

    expect(Object.getPrototypeOf(settlement)).toBe(Object.prototype);
    for (const value of Object.values(settlement)) {
      expect(value !== null && typeof value === 'object').toBe(false);
    }
    const record = settlement as unknown as Record<string, unknown>;
    expect(record.to).toBeUndefined();
    expect(record.message).toBeUndefined();
    expect(record.policy).toBeUndefined();
  });

  test('settledAt comes from the injected clock argument, not from the entry', () => {
    const entry = makeEntry();
    const first = settleMailboxEntry(entry, 'delivered', 1_000);
    const second = settleMailboxEntry(entry, 'delivered', 2_000);

    expect(first.settledAt).toBe(1_000);
    expect(second.settledAt).toBe(2_000);
  });
});
