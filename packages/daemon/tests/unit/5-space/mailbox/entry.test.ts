import { describe, expect, test } from 'bun:test';
import type { MailboxAddress } from '../../../../src/lib/space/mailbox/address';
import {
  createMailboxEntry,
  DEFAULT_MAILBOX_ENTRY_POLICY,
  isValidMailboxEntry,
  type MailboxMessage,
  validateMailboxMessage,
} from '../../../../src/lib/space/mailbox/entry';
import { isUlid } from '../../../../src/lib/space/mailbox/ulid';

const TO: MailboxAddress = { kind: 'session', sessionId: 'sess-1' };

class FakeAddress {
  kind = 'session';
  sessionId = 'sess-1';
}

function withHiddenField(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...payload };
  Object.defineProperty(copy, key, { value: copy[key], enumerable: false });
  return copy;
}

function withHiddenInnerContent(): Record<string, unknown> {
  const inner = { content: 'hi' };
  Object.defineProperty(inner, 'content', { value: 'hi', enumerable: false });
  return { type: 'user', message: inner, parent_tool_use_id: null };
}

function withHiddenBlockText(): Record<string, unknown> {
  const block = { type: 'text', text: 'hi' };
  Object.defineProperty(block, 'text', { value: 'hi', enumerable: false });
  return { type: 'user', message: { content: [block] }, parent_tool_use_id: null };
}

function withSymbolKey(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, [Symbol('extra')]: 'value' };
}

function messageWith(content: unknown): MailboxMessage {
  return {
    type: 'user',
    message: { content: content as MailboxMessage['message']['content'] },
    parent_tool_use_id: null,
  };
}

function stringMessage(): MailboxMessage {
  return messageWith('hello mailbox');
}

function blockMessage(): MailboxMessage {
  return messageWith([
    { type: 'text', text: 'first block' },
    { type: 'text', text: 'second block' },
  ]);
}

describe('validateMailboxMessage acceptance', () => {
  test.each([
    ['non-empty string content', stringMessage()],
    ['single text block', messageWith([{ type: 'text', text: 'only block' }])],
    ['multiple text blocks', blockMessage()],
    ['priority now', { ...stringMessage(), priority: 'now' }],
    ['priority next', { ...stringMessage(), priority: 'next' }],
    ['priority later', { ...stringMessage(), priority: 'later' }],
    ['null-prototype record', Object.assign(Object.create(null), stringMessage())],
  ])('accepts %s', (_label, message) => {
    expect(validateMailboxMessage(message)).toBe(null);
  });
});

describe('validateMailboxMessage rejection', () => {
  const base = { type: 'user', message: { content: 'hello' }, parent_tool_use_id: null };
  const rejections: [string, unknown, string][] = [
    ['non-object payload', 'user', 'must be an object'],
    ['array payload', [base], 'must be an object'],
    ['null payload', null, 'must be an object'],
    ['prototype-inherited fields', Object.create(base), 'must be an object'],
    ['symbol excess key', withSymbolKey(base), 'must be an object'],
    ['non-enumerable type', withHiddenField(base, 'type'), 'must be an enumerable own field'],
    [
      'non-enumerable parent_tool_use_id',
      withHiddenField(base, 'parent_tool_use_id'),
      'must be an enumerable own field',
    ],
    [
      'non-enumerable inner content',
      withHiddenInnerContent(),
      'must carry content as an enumerable own field',
    ],
    [
      'non-enumerable block text',
      withHiddenBlockText(),
      'must carry type and text as enumerable own fields',
    ],
    ['wrong type', { ...base, type: 'assistant' }, 'type must be "user"'],
    ['missing type', { message: base.message, parent_tool_use_id: null }, 'type must be "user"'],
    ['empty string content', { ...base, message: { content: '' } }, 'must not be empty'],
    ['empty block array', { ...base, message: { content: [] } }, 'must not be empty'],
    [
      'non-text block kind',
      { ...base, message: { content: [{ type: 'image', text: 'alt' }] } },
      'type must be "text"',
    ],
    [
      'block with empty text',
      { ...base, message: { content: [{ type: 'text', text: '' }] } },
      'text must be a non-empty string',
    ],
    [
      'block with excess key',
      { ...base, message: { content: [{ type: 'text', text: 'hi', citations: [] }] } },
      'must not carry key "citations"',
    ],
    [
      'non-object block',
      { ...base, message: { content: ['plain string'] } },
      'content block must be an object',
    ],
    [
      'non-string non-array content',
      { ...base, message: { content: 42 } },
      'must be a string or an array of text blocks',
    ],
    [
      'inner message excess key',
      { ...base, message: { content: 'hi', role: 'user' } },
      'must not carry key "role"',
    ],
    [
      'missing inner message',
      { type: 'user', parent_tool_use_id: null },
      'message.message must be an object',
    ],
    [
      'non-null parent_tool_use_id',
      { ...base, parent_tool_use_id: 'toolu_01ABC' },
      'parent_tool_use_id must be null',
    ],
    [
      'missing parent_tool_use_id',
      { type: 'user', message: { content: 'hi' } },
      'parent_tool_use_id must be null',
    ],
    ['invalid priority', { ...base, priority: 'asap' }, 'priority must be one of'],
    ['numeric priority', { ...base, priority: 1 }, 'priority must be one of'],
    ['explicit undefined priority', { ...base, priority: undefined }, 'priority must be one of'],
    ['uuid excess key', { ...base, uuid: 'abc' }, 'must not carry key "uuid"'],
    ['session_id excess key', { ...base, session_id: 'sess-1' }, 'must not carry key "session_id"'],
    [
      'subagent_type excess key',
      { ...base, subagent_type: 'space-task-agent' },
      'must not carry key "subagent_type"',
    ],
    [
      'task_description excess key',
      { ...base, task_description: 'do a thing' },
      'must not carry key "task_description"',
    ],
    ['isSynthetic excess key', { ...base, isSynthetic: true }, 'must not carry key "isSynthetic"'],
    [
      'tool_use_result excess key',
      { ...base, tool_use_result: 'output' },
      'must not carry key "tool_use_result"',
    ],
    ['shouldQuery excess key', { ...base, shouldQuery: true }, 'must not carry key "shouldQuery"'],
    [
      'timestamp excess key',
      { ...base, timestamp: '2026-08-31T00:00:00Z' },
      'must not carry key "timestamp"',
    ],
    ['unknown excess key', { ...base, custom: 'value' }, 'must not carry key "custom"'],
  ];

  test.each(rejections)('rejects %s', (_label, payload, reasonFragment) => {
    const reason = validateMailboxMessage(payload);
    expect(typeof reason).toBe('string');
    expect(reason).toContain(reasonFragment);
  });
});

describe('createMailboxEntry', () => {
  test('stamps a ULID id, enqueued status, and preserves origin', () => {
    const entry = createMailboxEntry({ to: TO, message: stringMessage(), origin: 'web:room-9' });
    expect(isUlid(entry.id)).toBe(true);
    expect(entry.status).toBe('enqueued');
    expect(entry.origin).toBe('web:room-9');
    expect(entry.to).toEqual(TO);
    expect(entry.message).toEqual(stringMessage());
  });

  test('applies default policy', () => {
    const entry = createMailboxEntry({ to: TO, message: stringMessage(), origin: 'web' });
    expect(entry.policy).toEqual(DEFAULT_MAILBOX_ENTRY_POLICY);
    expect(entry.policy.ttlMs).toBe(24 * 60 * 60 * 1000);
    expect(entry.policy.maxAttempts).toBe(5);
    expect(entry.policy.priority).toBe(0);
  });

  test('merges partial policy over defaults', () => {
    const entry = createMailboxEntry({
      to: TO,
      message: stringMessage(),
      origin: 'web',
      policy: { maxAttempts: 3, priority: 7 },
    });
    expect(entry.policy).toEqual({
      ttlMs: DEFAULT_MAILBOX_ENTRY_POLICY.ttlMs,
      maxAttempts: 3,
      priority: 7,
    });
  });

  test.each([
    ['zero ttlMs', { ttlMs: 0 }],
    ['negative ttlMs', { ttlMs: -1 }],
    ['fractional ttlMs', { ttlMs: 1000.5 }],
    ['non-numeric ttlMs', { ttlMs: 'long' }],
    ['infinite ttlMs', { ttlMs: Number.POSITIVE_INFINITY }],
    ['NaN ttlMs', { ttlMs: Number.NaN }],
    ['zero maxAttempts', { maxAttempts: 0 }],
    ['fractional maxAttempts', { maxAttempts: 2.5 }],
    ['negative priority', { priority: -1 }],
    ['negative zero priority', { priority: -0 }],
    ['fractional priority', { priority: 1.5 }],
    ['non-numeric priority', { priority: 'high' }],
    ['unknown policy key', { backoffMs: 100 } as Record<string, unknown>],
    ['null policy override', null],
    ['numeric policy override', 42],
    ['array policy override', [1, 2]],
  ])('throws TypeError on %s override', (_label, policy) => {
    expect(() =>
      createMailboxEntry({ to: TO, message: stringMessage(), origin: 'web', policy })
    ).toThrow(TypeError);
  });

  test('throws TypeError on a non-plain address object', () => {
    expect(() =>
      createMailboxEntry({
        to: new FakeAddress() as unknown as MailboxAddress,
        message: stringMessage(),
        origin: 'web',
      })
    ).toThrow('plain object');
  });

  test('throws TypeError naming the message violation', () => {
    const invalid = { type: 'user', message: { content: 'hi' }, parent_tool_use_id: 'toolu_1' };
    expect(() =>
      createMailboxEntry({ to: TO, message: invalid as unknown as MailboxMessage, origin: 'web' })
    ).toThrow('parent_tool_use_id must be null');
  });

  test('throws TypeError on explicit undefined priority', () => {
    const invalid = {
      type: 'user',
      message: { content: 'hi' },
      parent_tool_use_id: null,
      priority: undefined,
    };
    expect(() =>
      createMailboxEntry({ to: TO, message: invalid as unknown as MailboxMessage, origin: 'web' })
    ).toThrow('priority must be one of');
  });

  test('throws TypeError on invalid address', () => {
    expect(() =>
      createMailboxEntry({
        to: { kind: 'agent', spaceId: '', handle: 'coder' },
        message: stringMessage(),
        origin: 'web',
      })
    ).toThrow(TypeError);
  });

  test('throws TypeError on empty origin', () => {
    expect(() => createMailboxEntry({ to: TO, message: stringMessage(), origin: '' })).toThrow(
      TypeError
    );
  });

  test('throws TypeError on undefined optional address fields', () => {
    expect(() =>
      createMailboxEntry({
        to: { kind: 'agent', spaceId: 'sp-1', handle: 'coder', taskId: undefined },
        message: stringMessage(),
        origin: 'web',
      })
    ).toThrow(TypeError);
    expect(() =>
      createMailboxEntry({
        to: { kind: 'agent', spaceId: 'sp-1', handle: 'coder', node: undefined },
        message: stringMessage(),
        origin: 'web',
      })
    ).toThrow('must not carry undefined fields');
  });
});

describe('isValidMailboxEntry', () => {
  test('accepts a constructed entry', () => {
    expect(
      isValidMailboxEntry(createMailboxEntry({ to: TO, message: blockMessage(), origin: 'web' }))
    ).toBe(true);
  });

  test('rejects non-object entries', () => {
    expect(isValidMailboxEntry(null)).toBe(false);
    expect(isValidMailboxEntry('entry')).toBe(false);
    expect(
      isValidMailboxEntry([createMailboxEntry({ to: TO, message: stringMessage(), origin: 'web' })])
    ).toBe(false);
  });

  test.each([
    ['non-ULID id', (entry: Record<string, unknown>) => ({ ...entry, id: 'not-a-ulid' })],
    [
      'invalid address',
      (entry: Record<string, unknown>) => ({
        ...entry,
        to: { kind: 'agent', spaceId: 'sp-1' },
      }),
    ],
    [
      'bad message',
      (entry: Record<string, unknown>) => ({
        ...entry,
        message: { type: 'user', message: { content: '' }, parent_tool_use_id: null },
      }),
    ],
    ['wrong status', (entry: Record<string, unknown>) => ({ ...entry, status: 'delivered' })],
    [
      'address with undefined optional field',
      (entry: Record<string, unknown>) => ({
        ...entry,
        to: { kind: 'agent', spaceId: 'sp-1', handle: 'coder', taskId: undefined },
      }),
    ],
    [
      'non-plain address object',
      (entry: Record<string, unknown>) => ({ ...entry, to: new FakeAddress() }),
    ],
    [
      'policy with non-enumerable field',
      (entry: Record<string, unknown>) => {
        const policy = { ...copyPolicy(entry) };
        Object.defineProperty(policy, 'ttlMs', { value: policy.ttlMs, enumerable: false });
        return { ...entry, policy };
      },
    ],
    [
      'missing status',
      (entry: Record<string, unknown>) => {
        const copy = { ...entry };
        delete copy.status;
        return copy;
      },
    ],
    [
      'incomplete policy',
      (entry: Record<string, unknown>) => {
        const copy = { ...entry };
        const policy = { ...(copy.policy as Record<string, unknown>) };
        delete policy.maxAttempts;
        return { ...copy, policy };
      },
    ],
    [
      'invalid policy value',
      (entry: Record<string, unknown>) => ({
        ...entry,
        policy: { ...copyPolicy(entry), maxAttempts: 0 },
      }),
    ],
    ['excess entry key', (entry: Record<string, unknown>) => ({ ...entry, createdAt: 'today' })],
    ['symbol entry key', (entry: Record<string, unknown>) => withSymbolKey(entry)],
    ['prototype-inherited entry fields', (entry: Record<string, unknown>) => Object.create(entry)],
    [
      'missing message key',
      (entry: Record<string, unknown>) => {
        const copy = { ...entry };
        delete copy.message;
        return copy;
      },
    ],
  ])('rejects %s', (_label, tamper) => {
    const entry = createMailboxEntry({ to: TO, message: stringMessage(), origin: 'web' });
    expect(isValidMailboxEntry(tamper(entry as unknown as Record<string, unknown>))).toBe(false);
  });
});

function copyPolicy(entry: Record<string, unknown>): Record<string, unknown> {
  return { ...(entry.policy as Record<string, unknown>) };
}

describe('mailbox entry JSON law', () => {
  test.each([
    ['string content', stringMessage()],
    ['block content', blockMessage()],
    ['priority present', { ...stringMessage(), priority: 'next' }],
  ])('round-trips a constructed entry with %s', (_label, message) => {
    const entry = createMailboxEntry({ to: TO, message, origin: 'web:room-9' });
    const roundTripped = JSON.parse(JSON.stringify(entry));
    expect(roundTripped).toEqual(entry);
    expect(isValidMailboxEntry(roundTripped)).toBe(true);
  });

  test('round-trips a fully populated agent address', () => {
    const entry = createMailboxEntry({
      to: { kind: 'agent', spaceId: 'sp-1', handle: 'coder', taskId: '1725', node: 'Coding' },
      message: stringMessage(),
      origin: 'web',
    });
    const roundTripped = JSON.parse(JSON.stringify(entry));
    expect(roundTripped).toEqual(entry);
    expect(isValidMailboxEntry(roundTripped)).toBe(true);
  });

  test('round-tripped policy keeps every field', () => {
    const entry = createMailboxEntry({
      to: TO,
      message: stringMessage(),
      origin: 'web',
      policy: { ttlMs: 60_000, maxAttempts: 2, priority: 3 },
    });
    const roundTripped = JSON.parse(JSON.stringify(entry));
    expect(roundTripped.policy).toEqual({ ttlMs: 60_000, maxAttempts: 2, priority: 3 });
    expect(isValidMailboxEntry(roundTripped)).toBe(true);
  });
});
