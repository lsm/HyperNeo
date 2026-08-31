import { describe, expect, test } from 'bun:test';
import { type MailboxAddress } from '../../../../src/lib/space/mailbox/address';
import {
  createMailboxEntry,
  DEFAULT_MAILBOX_ENTRY_POLICY,
  isValidMailboxEntry,
  type MailboxEntry,
  type MailboxMessage,
  validateMailboxMessage,
} from '../../../../src/lib/space/mailbox/entry';
import { isUlid } from '../../../../src/lib/space/mailbox/ulid';

type CreateArgs = Parameters<typeof createMailboxEntry>[0];

const TO: MailboxAddress = { kind: 'agent', spaceId: 'sp-1', handle: 'coder' };
const SESSION_TO: MailboxAddress = { kind: 'session', sessionId: 'sess-1' };
const ORIGIN = 'space:chat';

const VALID_MESSAGE: MailboxMessage = {
  type: 'user',
  message: { content: 'hello' },
  parent_tool_use_id: null,
};

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

function buildMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'user', message: { content: 'hello' }, parent_tool_use_id: null, ...overrides };
}

function messageWith(content: unknown): Record<string, unknown> {
  return buildMessage({ message: { content } });
}

function entryArgs(): CreateArgs {
  return { to: TO, message: VALID_MESSAGE, origin: ORIGIN };
}

function buildEntry(): MailboxEntry {
  return createMailboxEntry(entryArgs());
}

function omit(source: object, key: string): unknown {
  const copy: Record<string, unknown> = { ...source };
  delete copy[key];
  return copy;
}

function tamper(source: object, patch: Record<string, unknown>): unknown {
  return { ...source, ...patch };
}

describe('DEFAULT_MAILBOX_ENTRY_POLICY', () => {
  test('carries the documented defaults', () => {
    expect(DEFAULT_MAILBOX_ENTRY_POLICY).toEqual({
      ttlMs: 24 * 60 * 60 * 1000,
      maxAttempts: 5,
      priority: 0,
    });
  });
});

describe('validateMailboxMessage', () => {
  test('accepts a non-empty string content', () => {
    expect(validateMailboxMessage(buildMessage())).toBeNull();
  });

  test('accepts a single text block content', () => {
    expect(validateMailboxMessage(messageWith([{ type: 'text', text: 'hi' }]))).toBeNull();
  });

  test('accepts multiple text block contents', () => {
    const content = [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ];
    expect(validateMailboxMessage(messageWith(content))).toBeNull();
  });

  test('accepts each priority value and its absence', () => {
    for (const priority of ['now', 'next', 'later']) {
      expect(validateMailboxMessage(buildMessage({ priority }))).toBeNull();
    }
    const withoutPriority = omit(buildMessage(), 'priority');
    expect(validateMailboxMessage(withoutPriority)).toBeNull();
  });

  test('rejects payloads that are not plain objects', () => {
    for (const payload of [null, undefined, 'user', 42, [], ['user']]) {
      expect(validateMailboxMessage(payload)).toContain('plain object');
    }
  });

  test('rejects a missing or non-user type', () => {
    expect(validateMailboxMessage(omit(buildMessage(), 'type'))).toContain('type');
    expect(validateMailboxMessage(buildMessage({ type: 'assistant' }))).toContain('type');
    expect(validateMailboxMessage(buildMessage({ type: 1 }))).toContain('type');
  });

  test('rejects a body that is not an object carrying only content', () => {
    expect(validateMailboxMessage(buildMessage({ message: undefined }))).toContain('message');
    expect(validateMailboxMessage(buildMessage({ message: [] }))).toContain('message');
    expect(validateMailboxMessage(buildMessage({ message: 'hello' }))).toContain('message');
    expect(
      validateMailboxMessage(buildMessage({ message: { content: 'x', role: 'user' } }))
    ).toContain('content field');
  });

  test('rejects empty, missing, or non-string non-array content', () => {
    expect(validateMailboxMessage(buildMessage({ message: {} }))).toContain('content');
    expect(validateMailboxMessage(messageWith(''))).toContain('content');
    expect(validateMailboxMessage(messageWith(7))).toContain('content');
  });

  test('rejects empty or malformed block arrays', () => {
    expect(validateMailboxMessage(messageWith([]))).toContain('empty');
    expect(validateMailboxMessage(messageWith(['plain']))).toContain('plain object');
    expect(validateMailboxMessage(messageWith([null]))).toContain('plain object');
  });

  test('rejects blocks that are not exactly text with non-empty text', () => {
    expect(validateMailboxMessage(messageWith([{ type: 'text' }]))).toContain('exactly');
    expect(validateMailboxMessage(messageWith([{}]))).toContain('exactly');
    expect(validateMailboxMessage(messageWith([{ type: 'text', text: 'a', extra: 1 }]))).toContain(
      'exactly'
    );
    expect(validateMailboxMessage(messageWith([{ type: 'image', text: 'a' }]))).toContain(
      'text blocks'
    );
    expect(validateMailboxMessage(messageWith([{ type: 'text', text: '' }]))).toContain(
      'non-empty text'
    );
    expect(validateMailboxMessage(messageWith([{ type: 'text', text: 5 }]))).toContain(
      'non-empty text'
    );
  });

  test('rejects a parent_tool_use_id that is not null', () => {
    expect(validateMailboxMessage(buildMessage({ parent_tool_use_id: 'toolu-1' }))).toContain(
      'parent_tool_use_id'
    );
    expect(validateMailboxMessage(omit(buildMessage(), 'parent_tool_use_id'))).toContain(
      'parent_tool_use_id'
    );
  });

  test('rejects a priority outside now, next, later', () => {
    expect(validateMailboxMessage(buildMessage({ priority: 'urgent' }))).toContain('priority');
    expect(validateMailboxMessage(buildMessage({ priority: 1 }))).toContain('priority');
    expect(validateMailboxMessage(buildMessage({ priority: null }))).toContain('priority');
  });

  test('rejects every named SDK excess key', () => {
    for (const key of EXCESS_KEYS) {
      expect(validateMailboxMessage(buildMessage({ [key]: 'x' }))).toContain(key);
    }
  });

  test('rejects any unknown key', () => {
    expect(validateMailboxMessage(buildMessage({ foo: 1 }))).toContain('foo');
  });
});

describe('createMailboxEntry', () => {
  test('stamps a ulid id, enqueued status, and preserves to, origin, message', () => {
    const entry = createMailboxEntry(entryArgs());
    expect(isUlid(entry.id)).toBe(true);
    expect(entry.status).toBe('enqueued');
    expect(entry.to).toEqual(TO);
    expect(entry.origin).toBe(ORIGIN);
    expect(entry.message).toEqual(VALID_MESSAGE);
  });

  test('applies the default policy when no override is given', () => {
    expect(createMailboxEntry(entryArgs()).policy).toEqual(DEFAULT_MAILBOX_ENTRY_POLICY);
  });

  test('merges a partial policy override over the defaults', () => {
    expect(createMailboxEntry({ ...entryArgs(), policy: { ttlMs: 1000 } }).policy).toEqual({
      ttlMs: 1000,
      maxAttempts: 5,
      priority: 0,
    });
    const full = createMailboxEntry({
      ...entryArgs(),
      policy: { ttlMs: 1, maxAttempts: 2, priority: 3 },
    });
    expect(full.policy).toEqual({ ttlMs: 1, maxAttempts: 2, priority: 3 });
  });

  test('rejects invalid policy override values with a TypeError', () => {
    const overrides = [
      { ttlMs: 0 },
      { ttlMs: -1 },
      { ttlMs: 1.5 },
      { ttlMs: Number.NaN },
      { ttlMs: Number.POSITIVE_INFINITY },
      { maxAttempts: 0 },
      { maxAttempts: 2.5 },
      { priority: -1 },
      { priority: 0.5 },
    ];
    for (const policy of overrides) {
      expect(() => createMailboxEntry({ ...entryArgs(), policy })).toThrow(TypeError);
    }
  });

  test('rejects unknown policy keys with a TypeError', () => {
    const args = tamper(entryArgs(), { policy: { ttlMs: 1, bogus: 2 } }) as CreateArgs;
    expect(() => createMailboxEntry(args)).toThrow(TypeError);
  });

  test('rejects missing required fields with a TypeError', () => {
    expect(() => createMailboxEntry(omit(entryArgs(), 'message') as CreateArgs)).toThrow(TypeError);
    expect(() => createMailboxEntry(omit(entryArgs(), 'to') as CreateArgs)).toThrow(TypeError);
    expect(() => createMailboxEntry(tamper(entryArgs(), { origin: '' }) as CreateArgs)).toThrow(
      TypeError
    );
  });

  test('rejects an invalid message and an invalid address with a TypeError', () => {
    const badMessage = buildMessage({ type: 'assistant' }) as unknown as MailboxMessage;
    expect(() => createMailboxEntry({ ...entryArgs(), message: badMessage })).toThrow(TypeError);
    const badTo = tamper(entryArgs(), { to: { kind: 'bogus' } }) as CreateArgs;
    expect(() => createMailboxEntry(badTo)).toThrow(TypeError);
  });
});

describe('isValidMailboxEntry', () => {
  test('accepts constructed entries for both address kinds', () => {
    expect(isValidMailboxEntry(buildEntry())).toBe(true);
    expect(isValidMailboxEntry(createMailboxEntry({ ...entryArgs(), to: SESSION_TO }))).toBe(true);
    expect(
      isValidMailboxEntry(
        createMailboxEntry({
          to: TO,
          origin: ORIGIN,
          message: {
            type: 'user',
            message: {
              content: [
                { type: 'text', text: 'a' },
                { type: 'text', text: 'b' },
              ],
            },
            parent_tool_use_id: null,
            priority: 'now',
          },
          policy: { ttlMs: 1000 },
        })
      )
    ).toBe(true);
  });

  test('rejects values that are not entries', () => {
    for (const value of [null, undefined, 'entry', 42, [], buildEntry().message]) {
      expect(isValidMailboxEntry(value)).toBe(false);
    }
  });

  test('rejects each tampered variant', () => {
    const entry = buildEntry();
    expect(isValidMailboxEntry(tamper(entry, { id: 'not-a-ulid' }))).toBe(false);
    expect(isValidMailboxEntry(tamper(entry, { id: 12345 }))).toBe(false);
    expect(isValidMailboxEntry(tamper(entry, { to: { kind: 'bogus' } }))).toBe(false);
    expect(isValidMailboxEntry(tamper(entry, { to: 'agent:sp-1/coder' }))).toBe(false);
    expect(isValidMailboxEntry(tamper(entry, { message: 'hello' }))).toBe(false);
    expect(isValidMailboxEntry(tamper(entry, { status: 'dequeued' }))).toBe(false);
    expect(isValidMailboxEntry(tamper(entry, { status: undefined }))).toBe(false);
    expect(isValidMailboxEntry(tamper(entry, { origin: '' }))).toBe(false);
    expect(isValidMailboxEntry(tamper(entry, { extra: 1 }))).toBe(false);
    expect(isValidMailboxEntry(tamper(entry, { policy: { ttlMs: 1, maxAttempts: 2 } }))).toBe(
      false
    );
    expect(isValidMailboxEntry(tamper(entry, { policy: 'fast' }))).toBe(false);
    expect(
      isValidMailboxEntry(tamper(entry, { policy: tamper(entry.policy, { priority: -1 }) }))
    ).toBe(false);
    expect(
      isValidMailboxEntry(
        tamper(entry, {
          message: { type: 'user', message: { content: '' }, parent_tool_use_id: null },
        })
      )
    ).toBe(false);
  });
});

describe('mailbox entry JSON round-trip law', () => {
  test('a constructed entry serializes, parses, deep-equals, and revalidates', () => {
    const cases: CreateArgs[] = [
      entryArgs(),
      { ...entryArgs(), to: SESSION_TO, policy: { ttlMs: 1000, priority: 2 } },
      {
        to: TO,
        origin: ORIGIN,
        message: {
          type: 'user',
          message: {
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
          },
          parent_tool_use_id: null,
          priority: 'later',
        },
      },
    ];
    for (const args of cases) {
      const entry = createMailboxEntry(args);
      expect(Object.keys(entry).sort()).toEqual([
        'id',
        'message',
        'origin',
        'policy',
        'status',
        'to',
      ]);
      const round = JSON.parse(JSON.stringify(entry)) as MailboxEntry;
      expect(round).toEqual(entry);
      expect(isValidMailboxEntry(round)).toBe(true);
    }
  });
});
