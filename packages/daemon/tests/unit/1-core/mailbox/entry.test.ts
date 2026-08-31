import { describe, expect, test } from 'bun:test';
import {
  createMailboxEntry,
  DEFAULT_MAILBOX_ENTRY_POLICY,
  type MailboxEntry,
  type MailboxEntryPolicy,
  type MailboxMessage,
  parseMailboxEntry,
  toMailboxMessage,
  toMailboxPolicy,
} from '../../../../src/lib/mailbox/entry';

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

describe('toMailboxMessage', () => {
  const validMessage: MailboxMessage = {
    type: 'user',
    message: { content: 'hello' },
    parent_tool_use_id: null,
  };

  const sparseContent: { type: 'text'; text: string }[] = [{ type: 'text', text: 'x' }];
  delete sparseContent[0];

  describe('projection', () => {
    test.each<[string, MailboxMessage]>([
      ['non-empty string content without priority', validMessage],
      [
        'a single text block',
        { ...validMessage, message: { content: [{ type: 'text', text: 'first' }] } },
      ],
      [
        'multiple text blocks',
        {
          ...validMessage,
          message: {
            content: [
              { type: 'text', text: 'first' },
              { type: 'text', text: 'second' },
            ],
          },
        },
      ],
      ['priority now', { ...validMessage, priority: 'now' }],
      ['priority next', { ...validMessage, priority: 'next' }],
      ['priority later', { ...validMessage, priority: 'later' }],
    ])('projects %s to a fresh deep-equal message', (_label, input) => {
      expect(toMailboxMessage(input)).toEqual({ message: input });
    });

    test('output keys are exactly the typed fields', () => {
      const withoutPriority = toMailboxMessage(validMessage) as { message: MailboxMessage };
      expect(Object.keys(withoutPriority.message).sort()).toEqual([
        'message',
        'parent_tool_use_id',
        'type',
      ]);
      const withPriority = toMailboxMessage({ ...validMessage, priority: 'next' }) as {
        message: MailboxMessage;
      };
      expect(Object.keys(withPriority.message).sort()).toEqual([
        'message',
        'parent_tool_use_id',
        'priority',
        'type',
      ]);
    });

    test('returns a fresh object graph, never the input reference', () => {
      const input: MailboxMessage = {
        ...validMessage,
        message: { content: [{ type: 'text', text: 'first' }] },
      };
      const result = toMailboxMessage(input) as { message: MailboxMessage };
      expect(result.message).not.toBe(input);
      expect(result.message.message).not.toBe(input.message);
      const projectedBlocks = result.message.message.content as { type: 'text'; text: string }[];
      const inputBlocks = input.message.content as { type: 'text'; text: string }[];
      expect(projectedBlocks[0]).not.toBe(inputBlocks[0]);
    });
  });

  describe('unknown input keys are dropped', () => {
    test.each([
      'uuid',
      'session_id',
      'subagent_type',
      'task_description',
      'isSynthetic',
      'tool_use_result',
      'shouldQuery',
      'timestamp',
      'kind',
    ])('drops %s by construction', (key) => {
      expect(toMailboxMessage({ ...validMessage, [key]: 'x' } as MailboxMessage)).toEqual({
        message: validMessage,
      });
    });
  });

  describe('value failures', () => {
    test.each<[string, unknown]>([
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
    ])('returns a reason for %s', (_label, message) => {
      expect(toMailboxMessage(message as unknown as MailboxMessage)).toEqual({
        reason: expect.any(String),
      });
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
      expect(() => toMailboxMessage(message)).not.toThrow();
      const result = toMailboxMessage(message);
      expect(result).toEqual({ reason: expect.any(String) });
      if ('reason' in result) expect(result.reason.includes('\n')).toBe(false);
    });
  });
});

describe('toMailboxPolicy', () => {
  test('defaults to DEFAULT_MAILBOX_ENTRY_POLICY when partial is undefined', () => {
    const result = toMailboxPolicy(undefined);
    expect(result).toEqual({ value: DEFAULT_MAILBOX_ENTRY_POLICY });
  });

  test('defaults to DEFAULT_MAILBOX_ENTRY_POLICY when partial is empty', () => {
    const result = toMailboxPolicy({});
    expect(result).toEqual({ value: DEFAULT_MAILBOX_ENTRY_POLICY });
  });

  test.each([
    ['ttlMs only', { ttlMs: 60_000 }, { ttlMs: 60_000, maxAttempts: 5, priority: 0 }],
    [
      'maxAttempts only',
      { maxAttempts: 1 },
      { ttlMs: 24 * 60 * 60 * 1000, maxAttempts: 1, priority: 0 },
    ],
    ['priority only', { priority: 3 }, { ttlMs: 24 * 60 * 60 * 1000, maxAttempts: 5, priority: 3 }],
    [
      'all fields',
      { ttlMs: 60_000, maxAttempts: 1, priority: 3 },
      { ttlMs: 60_000, maxAttempts: 1, priority: 3 },
    ],
  ])('merges valid overrides for %s', (_label, partial, expected) => {
    expect(toMailboxPolicy(partial)).toEqual({ value: expected });
  });

  test.each([
    ['non-integer ttlMs', { ttlMs: 1.5 }],
    ['non-finite ttlMs', { ttlMs: Infinity }],
    ['unsafe integer ttlMs', { ttlMs: Number.MAX_SAFE_INTEGER + 1 }],
    ['ttlMs below one', { ttlMs: 0 }],
    ['negative ttlMs', { ttlMs: -1 }],
    ['non-integer maxAttempts', { maxAttempts: 2.5 }],
    ['maxAttempts below one', { maxAttempts: 0 }],
    ['negative maxAttempts', { maxAttempts: -1 }],
    ['non-integer priority', { priority: 1.5 }],
    ['negative priority', { priority: -1 }],
    ['non-finite priority', { priority: NaN }],
  ])('returns a reason when %s', (_label, partial) => {
    expect(toMailboxPolicy(partial)).toEqual({ reason: expect.any(String) });
  });

  test('drops unknown keys by construction', () => {
    const result = toMailboxPolicy({ ttlMs: 60_000, unknown: 'x' } as Partial<MailboxEntryPolicy>);
    expect(result).toEqual({
      value: { ...DEFAULT_MAILBOX_ENTRY_POLICY, ttlMs: 60_000 },
    });
  });

  test('returns a fresh policy object, never the input or default reference', () => {
    const partial = { ttlMs: 60_000 };
    const result = toMailboxPolicy(partial) as { value: MailboxEntryPolicy };
    expect(result.value).not.toBe(partial);
    expect(result.value).not.toBe(DEFAULT_MAILBOX_ENTRY_POLICY);
  });
});

describe('createMailboxEntry', () => {
  test('throws the not implemented message', () => {
    expect(() =>
      createMailboxEntry({
        to: { kind: 'session', sessionId: 'sess-1' },
        message: {
          type: 'user',
          message: { content: 'hello' },
          parent_tool_use_id: null,
        },
        origin: 'test',
      })
    ).toThrow('mailbox: createMailboxEntry not implemented');
  });
});

describe('parseMailboxEntry', () => {
  test('throws the not implemented message', () => {
    expect(() => parseMailboxEntry({})).toThrow('mailbox: parseMailboxEntry not implemented');
  });
});
