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

  test('rejects a message with an inherited message container', () => {
    const inherited = Object.create({ content: 'hello' });
    expect(
      validateMailboxMessage({ ...MESSAGE_STRING, message: inherited } as unknown as MailboxMessage)
    ).not.toBeNull();
  });

  test('rejects an entry-level object with a custom prototype', () => {
    const inherited = Object.create({ type: 'user', message: { content: 'hello' } });
    expect(validateMailboxMessage(inherited)).not.toBeNull();
  });

  test('rejects Object.prototype.content pollution', () => {
    Object.defineProperty(Object.prototype, 'content', {
      value: 'hello',
      configurable: true,
      writable: true,
    });
    try {
      expect(
        validateMailboxMessage({
          type: 'user',
          message: {},
          parent_tool_use_id: null,
        } as unknown as MailboxMessage)
      ).not.toBeNull();
    } finally {
      Reflect.deleteProperty(Object.prototype, 'content');
    }
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

  test('rejects an inherited priority from Object.prototype', () => {
    Object.defineProperty(Object.prototype, 'priority', {
      value: 'now',
      configurable: true,
      writable: true,
    });
    try {
      const withoutOwn = { type: 'user', message: { content: 'hello' }, parent_tool_use_id: null };
      expect(validateMailboxMessage(withoutOwn as unknown as MailboxMessage)).not.toBeNull();
    } finally {
      Reflect.deleteProperty(Object.prototype, 'priority');
    }
  });

  test('rejects a content array with extra own properties', () => {
    const content = [{ type: 'text', text: 'hi' }] as unknown as { type: 'text'; text: string }[];
    (content as unknown as Record<string, unknown>).extra = 'x';
    expect(
      validateMailboxMessage({
        ...MESSAGE_STRING,
        message: { content },
      } as unknown as MailboxMessage)
    ).not.toBeNull();
  });

  test('rejects a content array with a toJSON method', () => {
    const content = [{ type: 'text', text: 'hi' }] as unknown as { type: 'text'; text: string }[];
    (content as unknown as Record<string, unknown>).toJSON = () => [];
    expect(
      validateMailboxMessage({
        ...MESSAGE_STRING,
        message: { content },
      } as unknown as MailboxMessage)
    ).not.toBeNull();
  });

  test('rejects a message with non-enumerable content', () => {
    const container: Record<string, unknown> = {};
    Object.defineProperty(container, 'content', {
      value: 'hello',
      enumerable: false,
      configurable: true,
    });
    expect(
      validateMailboxMessage({
        type: 'user',
        message: container,
        parent_tool_use_id: null,
      } as unknown as MailboxMessage)
    ).not.toBeNull();
  });

  test('rejects a hostile message object', () => {
    const proxy = new Proxy(
      { type: 'user', message: { content: 'hello' }, parent_tool_use_id: null },
      {
        get(target, prop) {
          if (prop === 'message') throw new Error('revoked');
          return (target as Record<string, unknown>)[prop as string];
        },
      }
    );
    expect(validateMailboxMessage(proxy as unknown as MailboxMessage)).not.toBeNull();
    expect(isValidMailboxEntry(proxy)).toBe(false);
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

  test('rejects a non-object policy override', () => {
    expect(() =>
      createMailboxEntry({
        to: SESSION_ADDRESS,
        message: MESSAGE_STRING,
        origin: 'api',
        policy: null as unknown as Partial<MailboxEntryPolicy>,
      })
    ).toThrow(TypeError);
    expect(() =>
      createMailboxEntry({
        to: SESSION_ADDRESS,
        message: MESSAGE_STRING,
        origin: 'api',
        policy: 0 as unknown as Partial<MailboxEntryPolicy>,
      })
    ).toThrow(TypeError);
  });

  test('rejects an address with inherited routing fields', () => {
    const withTask = Object.create({ taskId: '1725' });
    withTask.kind = 'agent';
    withTask.spaceId = 'sp-1';
    withTask.handle = 'coder';
    expect(() =>
      createMailboxEntry({
        to: withTask as unknown as MailboxAddress,
        message: MESSAGE_STRING,
        origin: 'api',
      })
    ).toThrow(TypeError);

    const withNode = Object.create({ node: 'Coding' });
    withNode.kind = 'agent';
    withNode.spaceId = 'sp-1';
    withNode.handle = 'coder';
    expect(() =>
      createMailboxEntry({
        to: withNode as unknown as MailboxAddress,
        message: MESSAGE_STRING,
        origin: 'api',
      })
    ).toThrow(TypeError);
  });

  test('rejects an address with Object.prototype taskId pollution', () => {
    Object.defineProperty(Object.prototype, 'taskId', {
      value: '1725',
      configurable: true,
      writable: true,
    });
    try {
      const withProto = { kind: 'agent', spaceId: 'sp-1', handle: 'coder' };
      expect(() =>
        createMailboxEntry({
          to: withProto as unknown as MailboxAddress,
          message: MESSAGE_STRING,
          origin: 'api',
        })
      ).toThrow(TypeError);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'taskId');
    }
  });

  test('snapshots a policy override before validating and merging', () => {
    let call = 0;
    const policy = {
      get ttlMs() {
        call += 1;
        return call === 1 ? 123456 : 0;
      },
    } as unknown as Partial<MailboxEntryPolicy>;
    const entry = createMailboxEntry({
      to: SESSION_ADDRESS,
      message: MESSAGE_STRING,
      origin: 'api',
      policy,
    });
    expect(entry.policy.ttlMs).toBe(123456);
    expect(isValidMailboxEntry(entry)).toBe(true);
  });

  test('default policy is immutable', () => {
    expect(Object.isFrozen(DEFAULT_MAILBOX_ENTRY_POLICY)).toBe(true);
    const entry = createMailboxEntry({
      to: SESSION_ADDRESS,
      message: MESSAGE_STRING,
      origin: 'api',
    });
    expect(entry.policy).toEqual({
      ttlMs: 24 * 60 * 60 * 1000,
      maxAttempts: 5,
      priority: 0,
    });
  });

  test('snapshots message and address inputs before returning', () => {
    let read = 0;
    const message = {
      get type() {
        return 'user';
      },
      get message() {
        read += 1;
        return { content: read === 1 ? 'hello' : '' };
      },
      get parent_tool_use_id() {
        return null;
      },
    } as unknown as MailboxMessage;
    expect(() =>
      createMailboxEntry({
        to: SESSION_ADDRESS,
        message,
        origin: 'api',
      })
    ).toThrow(TypeError);
  });

  test('ignores a non-enumerable toJSON on an address', () => {
    const to = { kind: 'session', sessionId: 'sess-1' } as unknown as MailboxAddress;
    Object.defineProperty(to, 'toJSON', {
      value: () => ({ kind: 'session', sessionId: 'evil' }),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const entry = createMailboxEntry({ to, message: MESSAGE_STRING, origin: 'api' });
    expect(entry.to).toEqual({ kind: 'session', sessionId: 'sess-1' });
    expect(isValidMailboxEntry(entry)).toBe(true);
  });

  test('ignores a non-enumerable toJSON on a message', () => {
    const message = { ...MESSAGE_STRING } as unknown as MailboxMessage;
    Object.defineProperty(message, 'toJSON', {
      value: () => ({ type: 'agent', message: { content: 'hacked' }, parent_tool_use_id: null }),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const entry = createMailboxEntry({ to: SESSION_ADDRESS, message, origin: 'api' });
    expect(entry.message).toEqual(MESSAGE_STRING);
    expect(isValidMailboxEntry(entry)).toBe(true);
  });

  test('ignores a non-enumerable toJSON on a content array', () => {
    const content = [{ type: 'text', text: 'hi' }] as unknown as { type: 'text'; text: string }[];
    Object.defineProperty(content, 'toJSON', {
      value: () => [],
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const message = {
      ...MESSAGE_ONE_BLOCK,
      message: { content },
    } as unknown as MailboxMessage;
    const entry = createMailboxEntry({ to: SESSION_ADDRESS, message, origin: 'api' });
    expect(entry.message).toEqual(MESSAGE_ONE_BLOCK);
    expect(isValidMailboxEntry(entry)).toBe(true);
  });

  test('ignores a non-enumerable toJSON on a content container', () => {
    const container: Record<string, unknown> = { content: 'hello' };
    Object.defineProperty(container, 'toJSON', {
      value: () => ({ content: 'hacked' }),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const message = {
      type: 'user',
      message: container,
      parent_tool_use_id: null,
    } as unknown as MailboxMessage;
    const entry = createMailboxEntry({ to: SESSION_ADDRESS, message, origin: 'api' });
    expect(entry.message).toEqual({
      type: 'user',
      message: { content: 'hello' },
      parent_tool_use_id: null,
    });
    expect(isValidMailboxEntry(entry)).toBe(true);
  });

  test('ignores a non-enumerable toJSON on a text block', () => {
    const block: Record<string, unknown> = { type: 'text', text: 'hi' };
    Object.defineProperty(block, 'toJSON', {
      value: () => ({ type: 'text', text: 'hacked' }),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const message = {
      type: 'user',
      message: { content: [block] },
      parent_tool_use_id: null,
    } as unknown as MailboxMessage;
    const entry = createMailboxEntry({ to: SESSION_ADDRESS, message, origin: 'api' });
    expect(entry.message).toEqual({
      type: 'user',
      message: { content: [{ type: 'text', text: 'hi' }] },
      parent_tool_use_id: null,
    });
    expect(isValidMailboxEntry(entry)).toBe(true);
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

  test('rejects an address with inherited routing fields', () => {
    const entry = makeEntry();
    const withTask = Object.create({ taskId: '1725' });
    withTask.kind = 'agent';
    withTask.spaceId = 'sp-1';
    withTask.handle = 'coder';
    expect(isValidMailboxEntry({ ...entry, to: withTask as unknown as MailboxAddress })).toBe(
      false
    );
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
