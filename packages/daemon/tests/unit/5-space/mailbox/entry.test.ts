import { describe, expect, test } from 'bun:test';
import { type MailboxAddress } from '../../../../src/lib/space/mailbox/address';
import {
  createMailboxEntry,
  DEFAULT_MAILBOX_ENTRY_POLICY,
  isValidMailboxEntry,
  validateMailboxMessage,
  type MailboxEntry,
  type MailboxEntryPolicy,
  type MailboxMessage,
} from '../../../../src/lib/space/mailbox/entry';
import { isUlid } from '../../../../src/lib/space/mailbox/ulid';

const SESSION_ADDRESS: MailboxAddress = { kind: 'session', sessionId: 'sess-1' };

const MESSAGE_STRING: MailboxMessage = {
  type: 'user',
  message: { content: 'hello' },
  parent_tool_use_id: null,
};

const MESSAGE_ONE_BLOCK: MailboxMessage = {
  type: 'user',
  message: { content: [{ type: 'text', text: 'hi' }] },
  parent_tool_use_id: null,
};

const MESSAGE_MULTI: MailboxMessage = {
  type: 'user',
  message: {
    content: [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ],
  },
  parent_tool_use_id: null,
};

function makeEntry(): MailboxEntry {
  return createMailboxEntry({
    to: SESSION_ADDRESS,
    message: MESSAGE_STRING,
    origin: 'api',
  });
}

describe('validateMailboxMessage', () => {
  test('accepts non-empty string content', () => {
    expect(validateMailboxMessage(MESSAGE_STRING)).toBeNull();
  });

  test('accepts a single text block', () => {
    expect(validateMailboxMessage(MESSAGE_ONE_BLOCK)).toBeNull();
  });

  test('accepts multiple text blocks', () => {
    expect(validateMailboxMessage(MESSAGE_MULTI)).toBeNull();
  });

  test('accepts each priority value', () => {
    for (const priority of ['now', 'next', 'later'] as const) {
      expect(validateMailboxMessage({ ...MESSAGE_STRING, priority })).toBeNull();
    }
  });

  test('rejects a non-object message', () => {
    expect(validateMailboxMessage(null)).not.toBeNull();
    expect(validateMailboxMessage('user')).not.toBeNull();
    expect(validateMailboxMessage([])).not.toBeNull();
  });

  test('rejects an unknown top-level key', () => {
    expect(validateMailboxMessage({ ...MESSAGE_STRING, extra: 'x' })).not.toBeNull();
  });

  for (const key of [
    'uuid',
    'session_id',
    'subagent_type',
    'task_description',
    'isSynthetic',
    'tool_use_result',
    'shouldQuery',
    'timestamp',
  ]) {
    test(`rejects top-level key ${key}`, () => {
      expect(validateMailboxMessage({ ...MESSAGE_STRING, [key]: 'x' })).not.toBeNull();
    });
  }

  test('rejects a type other than "user"', () => {
    expect(validateMailboxMessage({ ...MESSAGE_STRING, type: 'agent' })).not.toBeNull();
  });

  test('rejects an empty string content', () => {
    expect(validateMailboxMessage({ ...MESSAGE_STRING, message: { content: '' } })).not.toBeNull();
  });

  test('rejects an empty array content', () => {
    expect(validateMailboxMessage({ ...MESSAGE_STRING, message: { content: [] } })).not.toBeNull();
  });

  test('rejects a non-string non-array content', () => {
    expect(validateMailboxMessage({ ...MESSAGE_STRING, message: { content: 123 } })).not.toBeNull();
  });

  test('rejects an unknown key inside message.message', () => {
    expect(
      validateMailboxMessage({ ...MESSAGE_STRING, message: { content: 'hello', extra: 'x' } })
    ).not.toBeNull();
  });

  test('rejects a block array with a non-object block', () => {
    expect(
      validateMailboxMessage({ ...MESSAGE_STRING, message: { content: ['not a block'] } })
    ).not.toBeNull();
  });

  test('rejects a block with an unexpected key', () => {
    expect(
      validateMailboxMessage({
        ...MESSAGE_STRING,
        message: { content: [{ type: 'text', text: 'hi', source: 'x' }] },
      })
    ).not.toBeNull();
  });

  test('rejects a block whose type is not "text"', () => {
    expect(
      validateMailboxMessage({
        ...MESSAGE_STRING,
        message: { content: [{ type: 'image', text: 'hi' }] },
      })
    ).not.toBeNull();
  });

  test('rejects a block with missing type', () => {
    expect(
      validateMailboxMessage({ ...MESSAGE_STRING, message: { content: [{ text: 'hi' }] } })
    ).not.toBeNull();
  });

  test('rejects a block with missing text', () => {
    expect(
      validateMailboxMessage({ ...MESSAGE_STRING, message: { content: [{ type: 'text' }] } })
    ).not.toBeNull();
  });

  test('rejects a block with empty text', () => {
    expect(
      validateMailboxMessage({
        ...MESSAGE_STRING,
        message: { content: [{ type: 'text', text: '' }] },
      })
    ).not.toBeNull();
  });

  test('rejects a block with non-string text', () => {
    expect(
      validateMailboxMessage({
        ...MESSAGE_STRING,
        message: { content: [{ type: 'text', text: 123 }] },
      })
    ).not.toBeNull();
  });

  test('rejects a missing parent_tool_use_id', () => {
    const missing = { type: 'user', message: { content: 'hello' } } as unknown as MailboxMessage;
    expect(validateMailboxMessage(missing)).not.toBeNull();
  });

  test('rejects a non-null parent_tool_use_id', () => {
    expect(
      validateMailboxMessage({ ...MESSAGE_STRING, parent_tool_use_id: 'id-1' })
    ).not.toBeNull();
  });

  test('rejects an invalid priority', () => {
    expect(validateMailboxMessage({ ...MESSAGE_STRING, priority: 'urgent' })).not.toBeNull();
    expect(validateMailboxMessage({ ...MESSAGE_STRING, priority: 1 })).not.toBeNull();
  });
});

describe('createMailboxEntry', () => {
  test('stamps an ulid id and status enqueued', () => {
    const entry = createMailboxEntry({
      to: SESSION_ADDRESS,
      message: MESSAGE_STRING,
      origin: 'api',
    });
    expect(isUlid(entry.id)).toBe(true);
    expect(entry.status).toBe('enqueued');
    expect(isValidMailboxEntry(entry)).toBe(true);
  });

  test('preserves origin, to, message, and applies default policy', () => {
    const entry = createMailboxEntry({
      to: SESSION_ADDRESS,
      message: MESSAGE_STRING,
      origin: 'api',
    });
    expect(entry.to).toEqual(SESSION_ADDRESS);
    expect(entry.message).toEqual(MESSAGE_STRING);
    expect(entry.origin).toBe('api');
    expect(entry.policy).toEqual(DEFAULT_MAILBOX_ENTRY_POLICY);
  });

  test('applies partial policy overrides', () => {
    const entry = createMailboxEntry({
      to: SESSION_ADDRESS,
      message: MESSAGE_STRING,
      origin: 'api',
      policy: { priority: 2, maxAttempts: 3 },
    });
    expect(entry.policy.priority).toBe(2);
    expect(entry.policy.maxAttempts).toBe(3);
    expect(entry.policy.ttlMs).toBe(DEFAULT_MAILBOX_ENTRY_POLICY.ttlMs);
  });

  test('rejects an invalid message', () => {
    expect(() =>
      createMailboxEntry({
        to: SESSION_ADDRESS,
        message: { ...MESSAGE_STRING, type: 'agent' } as unknown as MailboxMessage,
        origin: 'api',
      })
    ).toThrow(TypeError);
  });

  test('rejects an invalid address', () => {
    expect(() =>
      createMailboxEntry({
        to: { kind: 'session' } as unknown as MailboxAddress,
        message: MESSAGE_STRING,
        origin: 'api',
      })
    ).toThrow(TypeError);
  });

  test('rejects an empty origin', () => {
    expect(() =>
      createMailboxEntry({
        to: SESSION_ADDRESS,
        message: MESSAGE_STRING,
        origin: '',
      })
    ).toThrow(TypeError);
  });

  test('rejects invalid policy override values', () => {
    expect(() =>
      createMailboxEntry({
        to: SESSION_ADDRESS,
        message: MESSAGE_STRING,
        origin: 'api',
        policy: { priority: -1 },
      })
    ).toThrow(TypeError);
    expect(() =>
      createMailboxEntry({
        to: SESSION_ADDRESS,
        message: MESSAGE_STRING,
        origin: 'api',
        policy: { ttlMs: 0 },
      })
    ).toThrow(TypeError);
    expect(() =>
      createMailboxEntry({
        to: SESSION_ADDRESS,
        message: MESSAGE_STRING,
        origin: 'api',
        policy: { maxAttempts: 1.5 },
      })
    ).toThrow(TypeError);
  });

  test('rejects an unknown policy override field', () => {
    expect(() =>
      createMailboxEntry({
        to: SESSION_ADDRESS,
        message: MESSAGE_STRING,
        origin: 'api',
        policy: { timeout: 1000 } as unknown as Partial<MailboxEntryPolicy>,
      })
    ).toThrow(TypeError);
  });
});

describe('isValidMailboxEntry', () => {
  test('accepts a constructed entry', () => {
    expect(isValidMailboxEntry(makeEntry())).toBe(true);
  });

  test('rejects a non-object', () => {
    expect(isValidMailboxEntry(null)).toBe(false);
    expect(isValidMailboxEntry('entry')).toBe(false);
    expect(isValidMailboxEntry([])).toBe(false);
  });

  test('rejects an extra key on the entry', () => {
    const entry = makeEntry();
    expect(isValidMailboxEntry({ ...entry, extra: 'x' })).toBe(false);
  });

  test('rejects a non-ulid id', () => {
    const entry = makeEntry();
    expect(isValidMailboxEntry({ ...entry, id: 'not-a-ulid' })).toBe(false);
  });

  test('rejects an invalid to', () => {
    const entry = makeEntry();
    expect(isValidMailboxEntry({ ...entry, to: { kind: 'session' } })).toBe(false);
  });

  test('rejects a bad message', () => {
    const entry = makeEntry();
    expect(
      isValidMailboxEntry({
        ...entry,
        message: { ...MESSAGE_STRING, type: 'agent' } as unknown as MailboxMessage,
      })
    ).toBe(false);
  });

  test('rejects a wrong status', () => {
    const entry = makeEntry();
    expect(isValidMailboxEntry({ ...entry, status: 'delivered' })).toBe(false);
  });

  test('rejects an incomplete policy', () => {
    const entry = makeEntry();
    const incomplete = {
      ttlMs: entry.policy.ttlMs,
      maxAttempts: entry.policy.maxAttempts,
    };
    expect(isValidMailboxEntry({ ...entry, policy: incomplete })).toBe(false);
  });

  test('rejects an invalid policy value', () => {
    const entry = makeEntry();
    expect(isValidMailboxEntry({ ...entry, policy: { ...entry.policy, priority: -1 } })).toBe(
      false
    );
  });

  test('rejects an unknown policy key', () => {
    const entry = makeEntry();
    expect(isValidMailboxEntry({ ...entry, policy: { ...entry.policy, extra: 1 } })).toBe(false);
  });
});

describe('round-trip law', () => {
  test('a constructed entry survives JSON serialization and revalidates', () => {
    const entry = createMailboxEntry({
      to: { kind: 'agent', spaceId: 'sp-1', handle: 'coder', taskId: '1725' },
      message: MESSAGE_MULTI,
      origin: 'api',
      policy: { priority: 1 },
    });
    const round = JSON.parse(JSON.stringify(entry));
    expect(round).toEqual(entry);
    expect(isValidMailboxEntry(round)).toBe(true);
  });
});
