import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAILBOX_ENTRY_POLICY,
  type MailboxEntry,
  type MailboxMessage,
  validateMailboxMessage,
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

describe('validateMailboxMessage', () => {
  const validMessage: MailboxMessage = {
    type: 'user',
    message: { content: 'hello' },
    parent_tool_use_id: null,
  };

  const sparseContent: { type: 'text'; text: string }[] = [{ type: 'text', text: 'x' }];
  delete sparseContent[0];

  describe('acceptance', () => {
    test.each<[string, MailboxMessage]>([
      ['non-empty string content without priority', validMessage],
      [
        'a single text block',
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'first' }] },
          parent_tool_use_id: null,
        },
      ],
      [
        'multiple text blocks',
        {
          type: 'user',
          message: {
            content: [
              { type: 'text', text: 'first' },
              { type: 'text', text: 'second' },
            ],
          },
          parent_tool_use_id: null,
        },
      ],
      ['priority now', { ...validMessage, priority: 'now' }],
      ['priority next', { ...validMessage, priority: 'next' }],
      ['priority later', { ...validMessage, priority: 'later' }],
    ])('accepts %s', (_label, message) => {
      expect(validateMailboxMessage(message)).toBeNull();
    });
  });

  describe('rejection', () => {
    test.each<[string, unknown]>([
      ['an array instead of an object', ['user']],
      ['a wrong type', { ...validMessage, type: 'assistant' }],
      [
        'empty string content',
        { type: 'user', message: { content: '' }, parent_tool_use_id: null },
      ],
      [
        'an empty block array',
        { type: 'user', message: { content: [] }, parent_tool_use_id: null },
      ],
      [
        'a non-text block',
        {
          type: 'user',
          message: { content: [{ type: 'image', text: 'x' }] },
          parent_tool_use_id: null,
        },
      ],
      [
        'an empty block text',
        {
          type: 'user',
          message: { content: [{ type: 'text', text: '' }] },
          parent_tool_use_id: null,
        },
      ],
      [
        'a sparse block array with a hole',
        { type: 'user', message: { content: sparseContent }, parent_tool_use_id: null },
      ],
      ['a non-null parent_tool_use_id', { ...validMessage, parent_tool_use_id: 'tool-1' }],
      ['an invalid priority', { ...validMessage, priority: 'soon' }],
      ['an unknown key', { ...validMessage, kind: 'enqueued' }],
    ])('rejects %s', (_label, message) => {
      const reason = validateMailboxMessage(message as unknown as MailboxMessage);
      expect(reason).toEqual(expect.any(String));
    });

    test.each([
      'uuid',
      'session_id',
      'subagent_type',
      'task_description',
      'isSynthetic',
      'tool_use_result',
      'shouldQuery',
      'timestamp',
    ])('rejects the named excess key %s', (key) => {
      const reason = validateMailboxMessage({ ...validMessage, [key]: 'x' } as MailboxMessage);
      expect(reason).toContain('unexpected key');
    });
  });

  describe('never-throw law', () => {
    test.each([
      42,
      ['user'],
      null,
      undefined,
      'user',
    ])('returns a one-line reason for %p instead of throwing', (garbage) => {
      const message = garbage as unknown as MailboxMessage;
      expect(() => validateMailboxMessage(message)).not.toThrow();
      const reason = validateMailboxMessage(message);
      expect(reason).toEqual(expect.any(String));
      expect(reason?.includes('\n')).toBe(false);
    });
  });
});
