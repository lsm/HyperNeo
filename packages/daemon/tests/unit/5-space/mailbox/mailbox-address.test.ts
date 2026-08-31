import { describe, expect, test } from 'bun:test';
import {
  isValidAddress,
  type MailboxAddress,
  parseAddress,
  renderAddress,
} from '../../../src/lib/space/mailbox/mailbox-address';

const SESSION_ADDR: MailboxAddress = { kind: 'session', sessionId: 'sess-123' };
const AGENT_ADDR: MailboxAddress = { kind: 'agent', spaceId: 'space-1', handle: '@coder' };
const AGENT_TASK_ADDR: MailboxAddress = {
  kind: 'agent',
  spaceId: 'space-1',
  handle: '@coder',
  taskId: 'task-9',
};
const AGENT_NODE_ADDR: MailboxAddress = {
  kind: 'agent',
  spaceId: 'space-1',
  handle: '@coder',
  node: 'Coding',
};
const AGENT_TASK_NODE_ADDR: MailboxAddress = {
  kind: 'agent',
  spaceId: 'space-1',
  handle: '@coder',
  taskId: 'task-9',
  node: 'Coding',
};

describe('renderAddress', () => {
  test('renders each grammar form', () => {
    expect(renderAddress(SESSION_ADDR)).toBe('session:sess-123');
    expect(renderAddress(AGENT_ADDR)).toBe('agent:space-1/@coder');
    expect(renderAddress(AGENT_TASK_ADDR)).toBe('agent:space-1/@coder?task=task-9');
    expect(renderAddress(AGENT_NODE_ADDR)).toBe('agent:space-1/@coder?node=Coding');
    expect(renderAddress(AGENT_TASK_NODE_ADDR)).toBe(
      'agent:space-1/@coder?task=task-9&node=Coding'
    );
  });

  test('omits undefined optional fields instead of rendering empty values', () => {
    expect(renderAddress({ kind: 'agent', spaceId: 's', handle: 'h', taskId: undefined })).toBe(
      'agent:s/h'
    );
  });

  test('percent-encodes reserved characters in values', () => {
    expect(renderAddress({ kind: 'session', sessionId: 'a/b?c&d=e%f#g' })).toBe(
      'session:a%2Fb%3Fc%26d%3De%25f%23g'
    );
    expect(renderAddress({ kind: 'agent', spaceId: 'a/b', handle: 'h?x' })).toBe(
      'agent:a%2Fb/h%3Fx'
    );
    expect(
      renderAddress({ kind: 'agent', spaceId: 's', handle: 'h', taskId: 't&1', node: 'n=1' })
    ).toBe('agent:s/h?task=t%261&node=n%3D1');
  });

  test('is canonical: equal addresses render to identical strings regardless of key order', () => {
    const first: MailboxAddress = {
      kind: 'agent',
      spaceId: 's',
      handle: 'h',
      node: 'n',
      taskId: 't',
    };
    const second: MailboxAddress = {
      kind: 'agent',
      spaceId: 's',
      handle: 'h',
      taskId: 't',
      node: 'n',
    };
    expect(renderAddress(first)).toBe(renderAddress(second));
    expect(renderAddress(first)).toBe('agent:s/h?task=t&node=n');
    expect(renderAddress(AGENT_TASK_NODE_ADDR)).toBe(renderAddress({ ...AGENT_TASK_NODE_ADDR }));
  });

  test('is deterministic across repeated calls', () => {
    expect(renderAddress(AGENT_TASK_NODE_ADDR)).toBe(renderAddress(AGENT_TASK_NODE_ADDR));
  });
});

describe('parseAddress', () => {
  test('parses each grammar form', () => {
    expect(parseAddress('session:sess-123')).toEqual(SESSION_ADDR);
    expect(parseAddress('agent:space-1/@coder')).toEqual(AGENT_ADDR);
    expect(parseAddress('agent:space-1/@coder?task=task-9')).toEqual(AGENT_TASK_ADDR);
    expect(parseAddress('agent:space-1/@coder?node=Coding')).toEqual(AGENT_NODE_ADDR);
    expect(parseAddress('agent:space-1/@coder?task=task-9&node=Coding')).toEqual(
      AGENT_TASK_NODE_ADDR
    );
  });

  test('decodes percent-encoded reserved characters', () => {
    expect(parseAddress('session:a%2Fb%3Fc%26d%3De%25f%23g')).toEqual({
      kind: 'session',
      sessionId: 'a/b?c&d=e%f#g',
    });
    expect(parseAddress('agent:a%2Fb/h%3Fx')).toEqual({
      kind: 'agent',
      spaceId: 'a/b',
      handle: 'h?x',
    });
    expect(parseAddress('agent:s/h%2Fsub')).toEqual({
      kind: 'agent',
      spaceId: 's',
      handle: 'h/sub',
    });
    expect(parseAddress('agent:s/h?task=t%261&node=n%3D1')).toEqual({
      kind: 'agent',
      spaceId: 's',
      handle: 'h',
      taskId: 't&1',
      node: 'n=1',
    });
  });

  test('round-trips every grammar form (parse ∘ render is identity)', () => {
    for (const addr of [
      SESSION_ADDR,
      AGENT_ADDR,
      AGENT_TASK_ADDR,
      AGENT_NODE_ADDR,
      AGENT_TASK_NODE_ADDR,
    ]) {
      expect(parseAddress(renderAddress(addr))).toEqual(addr);
    }
  });

  test('round-trips addresses with percent-encoded reserved characters', () => {
    const encoded: MailboxAddress[] = [
      { kind: 'session', sessionId: 'a/b?c&d=e%f' },
      { kind: 'agent', spaceId: 'sp/ace', handle: '@co/der?1' },
      { kind: 'agent', spaceId: 's', handle: 'h', taskId: 't/&=?', node: 'n/&=?' },
    ];
    for (const addr of encoded) {
      const raw = renderAddress(addr);
      expect(raw).not.toContain('/'.repeat(2));
      expect(parseAddress(raw)).toEqual(addr);
    }
  });

  test('returns null for unknown prefixes', () => {
    expect(parseAddress('')).toBeNull();
    expect(parseAddress('session')).toBeNull();
    expect(parseAddress('agent')).toBeNull();
    expect(parseAddress('mailbox:sess-1')).toBeNull();
    expect(parseAddress('Session:sess-1')).toBeNull();
    expect(parseAddress('AGENT:s/h')).toBeNull();
  });

  test('returns null for empty segments', () => {
    expect(parseAddress('session:')).toBeNull();
    expect(parseAddress('agent:')).toBeNull();
    expect(parseAddress('agent:/handle')).toBeNull();
    expect(parseAddress('agent:space/')).toBeNull();
    expect(parseAddress('agent:space/')).toBeNull();
    expect(parseAddress('agent:/')).toBeNull();
    expect(parseAddress('agent:s/h?task=')).toBeNull();
    expect(parseAddress('agent:s/h?node=')).toBeNull();
    expect(parseAddress('agent:s/h?task=a&node=')).toBeNull();
  });

  test('returns null for stray slashes', () => {
    expect(parseAddress('agent:s/h/x')).toBeNull();
    expect(parseAddress('agent:s/h/x?task=t')).toBeNull();
    expect(parseAddress('agent:s/h/')).toBeNull();
    expect(parseAddress('session:a/b')).toBeNull();
    expect(parseAddress('session:a/b?x')).toBeNull();
  });

  test('returns null for invalid query syntax', () => {
    expect(parseAddress('agent:s/h?')).toBeNull();
    expect(parseAddress('agent:s/h?task')).toBeNull();
    expect(parseAddress('agent:s/h?=x')).toBeNull();
    expect(parseAddress('agent:s/h?task=t&')).toBeNull();
    expect(parseAddress('agent:s/h?&task=t')).toBeNull();
    expect(parseAddress('agent:s/h?task=t&&node=n')).toBeNull();
    expect(parseAddress('agent:s/h?task=t&node')).toBeNull();
    expect(parseAddress('agent:s/h?%ZZ=1')).toBeNull();
    expect(parseAddress('agent:s/h?task=%ZZ')).toBeNull();
    expect(parseAddress('session:sess-1?x')).toBeNull();
  });

  test('rejects unknown query keys strictly instead of ignoring them', () => {
    expect(parseAddress('agent:s/h?foo=x')).toBeNull();
    expect(parseAddress('agent:s/h?task=t&foo=x')).toBeNull();
    expect(parseAddress('agent:s/h?foo=x&task=t')).toBeNull();
    expect(parseAddress('agent:s/h?Task=t')).toBeNull();
    expect(parseAddress('agent:s/h?tasks=t')).toBeNull();
  });

  test('rejects duplicate query keys', () => {
    expect(parseAddress('agent:s/h?task=a&task=b')).toBeNull();
    expect(parseAddress('agent:s/h?node=a&node=b')).toBeNull();
  });
});

describe('isValidAddress', () => {
  test('accepts every valid grammar-form address', () => {
    for (const addr of [
      SESSION_ADDR,
      AGENT_ADDR,
      AGENT_TASK_ADDR,
      AGENT_NODE_ADDR,
      AGENT_TASK_NODE_ADDR,
    ]) {
      expect(isValidAddress(addr)).toBe(true);
    }
  });

  test('accepts values with reserved characters that are legal within a field', () => {
    expect(isValidAddress({ kind: 'session', sessionId: 'a?b&c=d' })).toBe(true);
    expect(isValidAddress({ kind: 'agent', spaceId: 'a/b', handle: 'h?x' })).toBe(true);
  });

  test('rejects empty sessionId', () => {
    expect(isValidAddress({ kind: 'session', sessionId: '' })).toBe(false);
  });

  test('rejects empty spaceId', () => {
    expect(isValidAddress({ kind: 'agent', spaceId: '', handle: 'h' })).toBe(false);
  });

  test('rejects empty handle', () => {
    expect(isValidAddress({ kind: 'agent', spaceId: 's', handle: '' })).toBe(false);
  });

  test('rejects handle containing a slash', () => {
    expect(isValidAddress({ kind: 'agent', spaceId: 's', handle: 'a/b' })).toBe(false);
  });

  test('rejects empty taskId and node when present', () => {
    expect(isValidAddress({ kind: 'agent', spaceId: 's', handle: 'h', taskId: '' })).toBe(false);
    expect(isValidAddress({ kind: 'agent', spaceId: 's', handle: 'h', node: '' })).toBe(false);
    expect(
      isValidAddress({ kind: 'agent', spaceId: 's', handle: 'h', taskId: 't', node: '' })
    ).toBe(false);
  });

  test('rejects non-string field values', () => {
    expect(isValidAddress({ kind: 'session', sessionId: 42 } as unknown as MailboxAddress)).toBe(
      false
    );
    expect(
      isValidAddress({
        kind: 'agent',
        spaceId: 's',
        handle: 'h',
        taskId: 7,
      } as unknown as MailboxAddress)
    ).toBe(false);
  });

  test('rejects a session address carrying agent fields', () => {
    expect(
      isValidAddress({ kind: 'session', sessionId: 'x', spaceId: 's' } as unknown as MailboxAddress)
    ).toBe(false);
    expect(
      isValidAddress({ kind: 'session', sessionId: 'x', handle: 'h' } as unknown as MailboxAddress)
    ).toBe(false);
    expect(
      isValidAddress({ kind: 'session', sessionId: 'x', taskId: 't' } as unknown as MailboxAddress)
    ).toBe(false);
  });

  test('rejects an agent address carrying session fields or unknown keys', () => {
    expect(
      isValidAddress({
        kind: 'agent',
        spaceId: 's',
        handle: 'h',
        sessionId: 'x',
      } as unknown as MailboxAddress)
    ).toBe(false);
    expect(
      isValidAddress({
        kind: 'agent',
        spaceId: 's',
        handle: 'h',
        extra: 'x',
      } as unknown as MailboxAddress)
    ).toBe(false);
  });

  test('rejects unknown or missing kind', () => {
    expect(isValidAddress({ kind: 'mailbox' } as unknown as MailboxAddress)).toBe(false);
    expect(isValidAddress({ sessionId: 'x' } as unknown as MailboxAddress)).toBe(false);
  });

  test('rejects non-object inputs defensively', () => {
    expect(isValidAddress(null as unknown as MailboxAddress)).toBe(false);
    expect(isValidAddress(undefined as unknown as MailboxAddress)).toBe(false);
    expect(isValidAddress('session:x' as unknown as MailboxAddress)).toBe(false);
    expect(isValidAddress(['session'] as unknown as MailboxAddress)).toBe(false);
  });
});
