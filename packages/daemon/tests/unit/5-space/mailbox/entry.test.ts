import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAILBOX_ENTRY_POLICY,
  type MailboxEntry,
  type MailboxMessage,
} from '../../../../src/lib/space/mailbox/entry';

describe('DEFAULT_MAILBOX_ENTRY_POLICY', () => {
  test('equals the literal policy', () => {
    expect(DEFAULT_MAILBOX_ENTRY_POLICY).toEqual({
      ttlMs: 24 * 60 * 60 * 1000,
      maxAttempts: 5,
      priority: 0,
    });
  });

  test('carries integer values with non-negative priority', () => {
    const policy = DEFAULT_MAILBOX_ENTRY_POLICY;
    expect(Number.isInteger(policy.ttlMs)).toBe(true);
    expect(policy.ttlMs > 0).toBe(true);
    expect(Number.isInteger(policy.maxAttempts)).toBe(true);
    expect(policy.maxAttempts > 0).toBe(true);
    expect(Number.isInteger(policy.priority)).toBe(true);
    expect(policy.priority >= 0).toBe(true);
  });
});

describe('MailboxMessage', () => {
  const stringContent: MailboxMessage = {
    type: 'user',
    message: { content: 'hello' },
    parent_tool_use_id: null,
  };

  const singleBlockContent: MailboxMessage = {
    type: 'user',
    message: { content: [{ type: 'text', text: 'first' }] },
    parent_tool_use_id: null,
    priority: 'now',
  };

  const multiBlockContent: MailboxMessage = {
    type: 'user',
    message: {
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    },
    parent_tool_use_id: null,
    priority: 'later',
  };

  test('every valid content shape round-trips through JSON', () => {
    for (const message of [stringContent, singleBlockContent, multiBlockContent]) {
      expect(JSON.parse(JSON.stringify(message))).toEqual(message);
    }
  });
});

describe('MailboxEntry', () => {
  const toSession: MailboxEntry = {
    id: '00000000000000000000000000',
    to: { kind: 'session', sessionId: 'sess-1' },
    origin: 'space-task-agent',
    message: {
      type: 'user',
      message: { content: 'hello' },
      parent_tool_use_id: null,
    },
    status: 'enqueued',
    policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY },
  };

  const toAgent: MailboxEntry = {
    id: '00000000000000000000000001',
    to: { kind: 'agent', spaceId: 'sp-1', handle: 'coder', taskId: '1735', node: 'Coding' },
    origin: 'space-task-agent',
    message: {
      type: 'user',
      message: { content: [{ type: 'text', text: 'review when ready' }] },
      parent_tool_use_id: null,
      priority: 'next',
    },
    status: 'enqueued',
    policy: { ttlMs: 60_000, maxAttempts: 1, priority: 3 },
  };

  test('entries for both address kinds round-trip through JSON', () => {
    for (const entry of [toSession, toAgent]) {
      expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    }
  });
});
