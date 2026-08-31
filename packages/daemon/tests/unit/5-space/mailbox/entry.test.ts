import { describe, expect, test } from 'bun:test';
import type { MailboxAddress } from '../../../../src/lib/space/mailbox/address';
import {
  createMailboxEntry,
  DEFAULT_MAILBOX_ENTRY_POLICY,
  isValidMailboxEntry,
  type MailboxEntry,
  type MailboxMessage,
  validateMailboxMessage,
} from '../../../../src/lib/space/mailbox/entry';
import { isUlid } from '../../../../src/lib/space/mailbox/ulid';

const TO: MailboxAddress = { kind: 'session', sessionId: 'sess-1' };
const AGENT_TO: MailboxAddress = {
  kind: 'agent',
  spaceId: 'sp-1',
  handle: 'coder',
  taskId: '1734',
  node: 'Coding',
};

function messageWith(content: MailboxMessage['message']['content']): MailboxMessage {
  return { type: 'user', message: { content }, parent_tool_use_id: null };
}

function asMessage(value: unknown): MailboxMessage {
  return value as MailboxMessage;
}

const VALID_MESSAGES: Array<[string, MailboxMessage]> = [
  ['non-empty string content', messageWith('hello')],
  ['string content with emoji', messageWith('🚀')],
  ['single text block', messageWith([{ type: 'text', text: 'hi' }])],
  [
    'multiple text blocks',
    messageWith([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]),
  ],
];

const INVALID_MESSAGES: Array<[string, unknown]> = [
  [
    'wrong type',
    asMessage({ type: 'system', message: { content: 'hi' }, parent_tool_use_id: null }),
  ],
  ['missing type', { message: { content: 'hi' }, parent_tool_use_id: null }],
  ['missing inner message', asMessage({ type: 'user', parent_tool_use_id: null })],
  ['missing parent_tool_use_id', asMessage({ type: 'user', message: { content: 'hi' } })],
  [
    'parent_tool_use_id is a string',
    asMessage({ type: 'user', message: { content: 'hi' }, parent_tool_use_id: 'toolu_1' }),
  ],
  [
    'parent_tool_use_id is an object',
    asMessage({ type: 'user', message: { content: 'hi' }, parent_tool_use_id: {} }),
  ],
  ['empty string content', messageWith('')],
  ['missing content', asMessage({ type: 'user', message: {}, parent_tool_use_id: null })],
  ['number content', messageWith(42 as unknown as MailboxMessage['message']['content'])],
  ['null content', messageWith(null as unknown as MailboxMessage['message']['content'])],
  ['empty block array', messageWith([])],
  ['non-object block', messageWith(['hi'])],
  ['block with wrong type', messageWith([{ type: 'image', text: 'hi' }])],
  ['block missing type', messageWith([{ text: 'hi' }])],
  ['block with empty text', messageWith([{ type: 'text', text: '' }])],
  ['block with non-string text', messageWith([{ type: 'text', text: 7 }])],
  ['block with excess key', messageWith([{ type: 'text', text: 'hi', source: 'x' }])],
  [
    'inner message with excess key',
    asMessage({ type: 'user', message: { content: 'hi', cache: true }, parent_tool_use_id: null }),
  ],
  ['invalid priority', asMessage({ ...messageWith('hi'), priority: 'urgent' })],
];

const EXCESS_KEYS = [
  'uuid',
  'session_id',
  'subagent_type',
  'task_description',
  'isSynthetic',
  'tool_use_result',
  'shouldQuery',
  'timestamp',
];

describe('validateMailboxMessage', () => {
  test('accepts every valid content shape', () => {
    for (const [label, message] of VALID_MESSAGES) {
      expect(validateMailboxMessage(message), label).toBeNull();
    }
  });

  test('accepts each optional priority value', () => {
    for (const priority of ['now', 'next', 'later'] as const) {
      expect(validateMailboxMessage(asMessage({ ...messageWith('hi'), priority }))).toBeNull();
    }
  });

  test('rejects each contract violation with a readable reason', () => {
    for (const [label, message] of INVALID_MESSAGES) {
      const reason = validateMailboxMessage(message);
      expect(typeof reason, label).toBe('string');
      expect(reason, label).not.toHaveLength(0);
    }
  });

  test('rejects every named excess key', () => {
    for (const key of EXCESS_KEYS) {
      const reason = validateMailboxMessage({ ...messageWith('hi'), [key]: 'value' });
      expect(reason, key).not.toBeNull();
    }
  });

  test('rejects unknown keys', () => {
    for (const key of ['foo', 'bar baz', 'PRIORITY']) {
      expect(validateMailboxMessage({ ...messageWith('hi'), [key]: 'value' })).not.toBeNull();
    }
  });

  test('never throws on non-message inputs', () => {
    for (const value of [null, undefined, 'user', 42, [], true]) {
      expect(validateMailboxMessage(value)).not.toBeNull();
    }
  });

  test('names the offending key in excess-key reasons', () => {
    expect(validateMailboxMessage({ ...messageWith('hi'), uuid: 'u-1' })).toContain('uuid');
    expect(validateMailboxMessage({ ...messageWith('hi'), foo: 1 })).toContain('foo');
  });
});

describe('createMailboxEntry', () => {
  test('stamps a ULID id and enqueued status, preserving addressing and origin', () => {
    const entry = createMailboxEntry({ to: TO, message: messageWith('hi'), origin: 'space/1734' });
    expect(isUlid(entry.id)).toBe(true);
    expect(entry.status).toBe('enqueued');
    expect(entry.to).toEqual(TO);
    expect(entry.origin).toBe('space/1734');
    expect(entry.message).toEqual(messageWith('hi'));
  });

  test('preserves agent addressing and message priority', () => {
    const message = asMessage({ ...messageWith('hi'), priority: 'now' });
    const entry = createMailboxEntry({ to: AGENT_TO, message, origin: 'o' });
    expect(entry.to).toEqual(AGENT_TO);
    expect(entry.message.priority).toBe('now');
  });

  test('applies the default policy when none is given', () => {
    const entry = createMailboxEntry({ to: TO, message: messageWith('hi'), origin: 'o' });
    expect(entry.policy).toEqual(DEFAULT_MAILBOX_ENTRY_POLICY);
  });

  test('merges a partial override over the defaults', () => {
    const entry = createMailboxEntry({
      to: TO,
      message: messageWith('hi'),
      origin: 'o',
      policy: { ttlMs: 60_000 },
    });
    expect(entry.policy).toEqual({ ttlMs: 60_000, maxAttempts: 5, priority: 0 });
  });

  test('applies a full override including zero priority', () => {
    const entry = createMailboxEntry({
      to: TO,
      message: messageWith('hi'),
      origin: 'o',
      policy: { ttlMs: 1, maxAttempts: 1, priority: 0 },
    });
    expect(entry.policy).toEqual({ ttlMs: 1, maxAttempts: 1, priority: 0 });
  });

  test('rejects invalid policy override values with a TypeError', () => {
    const overrides: Array<Partial<{ ttlMs: number; maxAttempts: number; priority: number }>> = [
      { ttlMs: 0 },
      { ttlMs: -1 },
      { ttlMs: 1.5 },
      { ttlMs: Number.NaN },
      { ttlMs: Infinity },
      { maxAttempts: 0 },
      { maxAttempts: -2 },
      { priority: -1 },
      { priority: 0.5 },
      { priority: Number.NaN },
    ];
    for (const policy of overrides) {
      expect(
        () => createMailboxEntry({ to: TO, message: messageWith('hi'), origin: 'o', policy }),
        JSON.stringify(policy)
      ).toThrow(TypeError);
    }
  });

  test('rejects excess keys in policy override', () => {
    const excessPolicies = [
      { ttlMs: 1000, foo: 'bar' },
      { maxAttempts: 3, extra: true },
      { priority: 1, junk: null },
    ];
    for (const policy of excessPolicies) {
      expect(
        () => createMailboxEntry({ to: TO, message: messageWith('hi'), origin: 'o', policy }),
        JSON.stringify(policy)
      ).toThrow(TypeError);
    }
  });

  test('rejects excess keys in policy override', () => {
    const excessPolicies = [
      { ttlMs: 1000, foo: 'bar' },
      { maxAttempts: 3, extra: true },
      { priority: 1, junk: null },
    ];
    for (const policy of excessPolicies) {
      expect(
        () => createMailboxEntry({ to: TO, message: messageWith('hi'), origin: 'o', policy }),
        JSON.stringify(policy)
      ).toThrow(TypeError);
    }
  });

  test('throws a TypeError naming the first violation for an invalid message', () => {
    const bad = asMessage({ ...messageWith(''), uuid: 'u-1' });
    expect(() => createMailboxEntry({ to: TO, message: bad, origin: 'o' })).toThrow(TypeError);
  });

  test('throws a TypeError for an invalid address', () => {
    for (const to of [
      { kind: 'session', sessionId: '' },
      { kind: 'room', roomId: 'r-1' } as never,
      null as never,
    ]) {
      expect(() => createMailboxEntry({ to, message: messageWith('hi'), origin: 'o' })).toThrow(
        TypeError
      );
    }
  });

  test('throws a TypeError for an empty or non-string origin', () => {
    expect(() => createMailboxEntry({ to: TO, message: messageWith('hi'), origin: '' })).toThrow(
      TypeError
    );
    expect(() =>
      createMailboxEntry({ to: TO, message: messageWith('hi'), origin: 42 as never })
    ).toThrow(TypeError);
  });
});

describe('isValidMailboxEntry', () => {
  function build(): MailboxEntry {
    return createMailboxEntry({ to: TO, message: messageWith('hi'), origin: 'o' });
  }

  test('accepts a constructed entry', () => {
    expect(isValidMailboxEntry(build())).toBe(true);
  });

  test('accepts an entry with agent addressing and priority', () => {
    const entry = createMailboxEntry({
      to: AGENT_TO,
      message: asMessage({ ...messageWith([{ type: 'text', text: 'x' }]), priority: 'later' }),
      origin: 'o',
    });
    expect(isValidMailboxEntry(entry)).toBe(true);
  });

  test('rejects a non-ULID id', () => {
    for (const id of [
      'not-a-ulid',
      '0123456789ABCDEFGHJKMNPQRSTVWXY',
      createMailboxEntry({ to: TO, message: messageWith('hi'), origin: 'o' }).id.toLowerCase(),
    ]) {
      expect(isValidMailboxEntry({ ...build(), id })).toBe(false);
    }
  });

  test('rejects an invalid address', () => {
    for (const to of [
      { kind: 'session', sessionId: '' },
      { kind: 'agent', spaceId: 'sp-1' },
      { kind: 'room', roomId: 'r-1' },
      'session:sess-1',
    ]) {
      expect(isValidMailboxEntry({ ...build(), to: to as never })).toBe(false);
    }
  });

  test('rejects a bad message', () => {
    const entry = build();
    expect(isValidMailboxEntry({ ...entry, message: messageWith('') })).toBe(false);
    expect(
      isValidMailboxEntry({
        ...entry,
        message: asMessage({
          type: 'system',
          message: { content: 'hi' },
          parent_tool_use_id: null,
        }),
      })
    ).toBe(false);
  });

  test('rejects a wrong status', () => {
    for (const status of ['delivered', 'failed', 'enqueued ', '']) {
      expect(isValidMailboxEntry({ ...build(), status: status as never })).toBe(false);
    }
  });

  test('rejects an incomplete or invalid policy', () => {
    const entry = build();
    for (const policy of [
      {},
      { ttlMs: 86_400_000 },
      { ttlMs: 86_400_000, maxAttempts: 5 },
      { ttlMs: 86_400_000, maxAttempts: 5, priority: -1 },
      { ttlMs: 0, maxAttempts: 5, priority: 0 },
      { ttlMs: 1.5, maxAttempts: 5, priority: 0 },
      null,
    ]) {
      expect(isValidMailboxEntry({ ...entry, policy: policy as never })).toBe(false);
    }
  });

  test('rejects an excess entry key', () => {
    expect(isValidMailboxEntry({ ...build(), queue: 'high' })).toBe(false);
  });

  test('rejects a missing entry key', () => {
    const { origin: _origin, ...noOrigin } = build();
    expect(isValidMailboxEntry(noOrigin)).toBe(false);
    const { id: _id, ...noId } = build();
    expect(isValidMailboxEntry(noId)).toBe(false);
  });

  test('never throws on non-entry inputs', () => {
    for (const value of [null, undefined, 'entry', 42, [], true, new Date()]) {
      expect(isValidMailboxEntry(value)).toBe(false);
    }
  });

  test('rejects entries whose keys are inherited rather than own', () => {
    const entry = Object.create(build());
    expect(isValidMailboxEntry(entry)).toBe(false);
  });

  test('rejects entries with non-enumerable required fields', () => {
    const entry = build();
    for (const key of ['id', 'to', 'origin', 'message', 'status', 'policy']) {
      const def = Object.entries(entry).filter(([k]) => k !== key);
      const fake = Object.fromEntries(def);
      Object.defineProperty(fake, key, {
        value: (entry as Record<string, unknown>)[key],
        enumerable: false,
      });
      expect(isValidMailboxEntry(fake)).toBe(false);
    }
  });
});

describe('JSON round-trip law', () => {
  test('a constructed entry survives serialize-parse unchanged and revalidates', () => {
    const entry = createMailboxEntry({
      to: AGENT_TO,
      message: asMessage({ ...messageWith([{ type: 'text', text: 'hello' }]), priority: 'next' }),
      origin: 'space/1734',
      policy: { ttlMs: 60_000 },
    });
    const roundTripped = JSON.parse(JSON.stringify(entry)) as MailboxEntry;
    expect(roundTripped).toEqual(entry);
    expect(isValidMailboxEntry(roundTripped)).toBe(true);
  });

  test('round-trips the minimal default-policy shape', () => {
    const entry = createMailboxEntry({ to: TO, message: messageWith('hi'), origin: 'o' });
    const roundTripped = JSON.parse(JSON.stringify(entry)) as MailboxEntry;
    expect(roundTripped).toEqual(entry);
    expect(isValidMailboxEntry(roundTripped)).toBe(true);
  });

  test('revalidates a round-tripped entry with multi-block content and zero priority', () => {
    const entry = createMailboxEntry({
      to: TO,
      message: messageWith([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
      origin: 'o',
      policy: { priority: 0 },
    });
    expect(isValidMailboxEntry(JSON.parse(JSON.stringify(entry)))).toBe(true);
  });
});
