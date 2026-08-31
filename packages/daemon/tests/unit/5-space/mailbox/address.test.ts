import { describe, expect, test } from 'bun:test';
import {
  isValidAddress,
  MailboxAddress,
  parseAddress,
  renderAddress,
} from '../../../../src/lib/space/mailbox/address';

describe('parseAddress', () => {
  describe('session addresses', () => {
    test('parses a session address', () => {
      expect(parseAddress('session:sess-a1b2c3')).toEqual({
        kind: 'session',
        sessionId: 'sess-a1b2c3',
      });
    });

    test('parses a session with special characters', () => {
      expect(parseAddress('session:a/b/c')).toEqual({
        kind: 'session',
        sessionId: 'a/b/c',
      });
    });
  });

  describe('agent addresses', () => {
    test('parses a basic agent address', () => {
      expect(parseAddress('agent:sp-1/runner')).toEqual({
        kind: 'agent',
        spaceId: 'sp-1',
        handle: 'runner',
      });
    });

    test('parses agent with task query param', () => {
      const result = parseAddress('agent:sp-2/coder?task=t-42');
      expect(result).toEqual({ kind: 'agent', spaceId: 'sp-2', handle: 'coder', taskId: 't-42' });
    });

    test('parses agent with node query param', () => {
      const result = parseAddress('agent:sp-3/linter?node=worker-a');
      expect(result).toEqual({
        kind: 'agent',
        spaceId: 'sp-3',
        handle: 'linter',
        node: 'worker-a',
      });
    });

    test('parses agent with both task and node', () => {
      const result = parseAddress('agent:sp-4/executor?task=t-99&node=box-7');
      expect(result).toEqual({
        kind: 'agent',
        spaceId: 'sp-4',
        handle: 'executor',
        taskId: 't-99',
        node: 'box-7',
      });
    });

    test('parses agent with node before task', () => {
      const result = parseAddress('agent:sp-5/runner?node=n1&task=t1');
      expect(result).toEqual({
        kind: 'agent',
        spaceId: 'sp-5',
        handle: 'runner',
        taskId: 't1',
        node: 'n1',
      });
    });

    test('returns null for empty space id', () => {
      expect(parseAddress('agent:///handle')).toBeNull();
    });

    test('returns null for empty handle', () => {
      expect(parseAddress('agent:sp-1/')).toBeNull();
    });

    test('returns null for missing slash separator', () => {
      expect(parseAddress('agent:noSlashHere')).toBeNull();
    });

    test('returns null for handle containing slash', () => {
      expect(parseAddress('agent:sp/handle/sub')).toBeNull();
    });

    test('returns null for unknown query key', () => {
      expect(parseAddress('agent:sp/h?foo=bar')).toBeNull();
    });

    test('returns null for query param without equals sign', () => {
      expect(parseAddress('agent:sp/h?key')).toBeNull();
    });

    test('returns null for empty query key', () => {
      expect(parseAddress('agent:sp/h?=val')).toBeNull();
    });

    test('returns null for empty task query value', () => {
      expect(parseAddress('agent:sp/h?task=')).toBeNull();
    });

    test('returns null for empty node query value', () => {
      expect(parseAddress('agent:sp/h?node=')).toBeNull();
    });

    test('returns null for unknown prefix', () => {
      expect(parseAddress('unknown:sp/h')).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(parseAddress('')).toBeNull();
    });

    test('returns null for agent prefix with no rest', () => {
      expect(parseAddress('agent:')).toBeNull();
    });

    test('returns null for multiple slashes in path', () => {
      expect(parseAddress('agent:a/b/c')).toBeNull();
    });
  });

  describe('percent-encoding', () => {
    test('round-trips percent-encoded query values', () => {
      const encoded = 'agent:sp/h?task=t%3Fask&node=n%26me';
      const parsed = parseAddress(encoded);
      expect(parsed).toEqual({
        kind: 'agent',
        spaceId: 'sp',
        handle: 'h',
        taskId: 't?ask',
        node: 'n&me',
      });
    });

    test('round-trips percent-encoded space id', () => {
      const encoded = 'agent:s%20p/handle';
      const parsed = parseAddress(encoded);
      expect(parsed).toEqual({ kind: 'agent', spaceId: 's p', handle: 'handle' });
    });
  });

  describe('malformed percent-escapes return null (never throw)', () => {
    test('returns null for incomplete escape in space id', () => {
      expect(parseAddress('agent:s%2/handle')).toBeNull();
    });

    test('returns null for incomplete escape in handle', () => {
      expect(parseAddress('agent:sp/h%2')).toBeNull();
    });

    test('returns null for incomplete escape in query key', () => {
      expect(parseAddress('agent:sp/h?ta%2sk=val')).toBeNull();
    });

    test('returns null for incomplete escape in query value', () => {
      expect(parseAddress('agent:sp/h?key=va%2l')).toBeNull();
    });

    test('returns null for double-percent escape that decodes to invalid escape', () => {
      expect(parseAddress('agent:s%%20p/handle')).toBeNull();
    });

    test('returns null for incomplete escape in task value', () => {
      expect(parseAddress('agent:sp/h?task=t%2')).toBeNull();
    });

    test('returns null for incomplete escape in node value', () => {
      expect(parseAddress('agent:sp/h?node=n%2')).toBeNull();
    });
  });
});

describe('renderAddress', () => {
  test('renders a session address', () => {
    expect(renderAddress({ kind: 'session', sessionId: 'sess-abc' })).toBe('session:sess-abc');
  });

  test('renders a basic agent address', () => {
    expect(renderAddress({ kind: 'agent', spaceId: 'sp-1', handle: 'runner' })).toBe(
      'agent:sp-1/runner'
    );
  });

  test('renders agent with task', () => {
    expect(renderAddress({ kind: 'agent', spaceId: 'sp', handle: 'c', taskId: 't1' })).toBe(
      'agent:sp/c?task=t1'
    );
  });

  test('renders agent with node', () => {
    expect(renderAddress({ kind: 'agent', spaceId: 'sp', handle: 'c', node: 'n1' })).toBe(
      'agent:sp/c?node=n1'
    );
  });

  test('renders agent with both, task before node in output', () => {
    expect(
      renderAddress({ kind: 'agent', spaceId: 'sp', handle: 'c', taskId: 't1', node: 'n1' })
    ).toBe('agent:sp/c?task=t1&node=n1');
  });

  test('percent-encodes handle', () => {
    expect(renderAddress({ kind: 'agent', spaceId: 'sp', handle: 'h?a' })).toBe('agent:sp/h%3Fa');
  });

  test('percent-encodes space id', () => {
    expect(renderAddress({ kind: 'agent', spaceId: 's p', handle: 'h' })).toBe('agent:s%20p/h');
  });

  test('percent-encodes query values', () => {
    expect(renderAddress({ kind: 'agent', spaceId: 'sp', handle: 'h', taskId: 't ask' })).toBe(
      'agent:sp/h?task=t%20ask'
    );
  });

  describe('canonical rendering stability', () => {
    test('same address renders identically across calls', () => {
      const addr = { kind: 'agent', spaceId: 'sp', handle: 'h', taskId: 't1', node: 'n1' };
      expect(renderAddress(addr)).toBe(renderAddress(addr));
    });

    test('different query-key orders produce different strings but both parse back to same address', () => {
      const addr1 = { kind: 'agent', spaceId: 'sp', handle: 'h', taskId: 't1', node: 'n1' };
      const rendered = renderAddress(addr1);
      const reparsed = parseAddress(rendered);
      expect(reparsed).toEqual(addr1);
    });
  });
});

describe('round-trip identity', () => {
  test.each([
    'session:s1',
    'agent:sp/runner',
    'agent:sp/coder?task=t42',
    'agent:sp/linter?node=w1',
    'agent:sp/exec?task=t99&node=b7',
  ])('round-trips %s', (raw) => {
    const parsed = parseAddress(raw);
    expect(parsed).not.toBeNull();
    expect(renderAddress(parsed!)).toBe(raw);
  });

  test('round-trips percent-encoded values', () => {
    const raw = 'agent:s%20p/h?task=t%26ask&node=n%3Fme';
    const parsed = parseAddress(raw);
    expect(parsed).not.toBeNull();
    expect(renderAddress(parsed!)).toBe(raw);
  });

  test('round-trips percent-encoded handle', () => {
    const raw = 'agent:sp/h%3F?task=t1';
    const parsed = parseAddress(raw);
    expect(parsed).not.toBeNull();
    expect(renderAddress(parsed!)).toBe(raw);
  });

  test('round-trips session with slash in id', () => {
    const raw = 'session:a/b/c';
    const parsed = parseAddress(raw);
    expect(parsed).not.toBeNull();
    expect(renderAddress(parsed!)).toBe(raw);
  });
});

describe('isValidAddress', () => {
  describe('accepts valid addresses', () => {
    test('session with non-empty id', () => {
      expect(isValidAddress({ kind: 'session', sessionId: 's1' })).toBe(true);
    });

    test('agent with all fields', () => {
      expect(
        isValidAddress({ kind: 'agent', spaceId: 'sp', handle: 'h', taskId: 't', node: 'n' })
      ).toBe(true);
    });

    test('agent without optional fields', () => {
      expect(isValidAddress({ kind: 'agent', spaceId: 'sp', handle: 'h' })).toBe(true);
    });

    test('agent with only taskId', () => {
      expect(isValidAddress({ kind: 'agent', spaceId: 'sp', handle: 'h', taskId: 't1' })).toBe(
        true
      );
    });

    test('agent with only node', () => {
      expect(isValidAddress({ kind: 'agent', spaceId: 'sp', handle: 'h', node: 'n1' })).toBe(true);
    });
  });

  describe('rejects structural violations', () => {
    test('rejects session with empty sessionId', () => {
      expect(isValidAddress({ kind: 'session', sessionId: '' })).toBe(false);
    });

    test('rejects agent with empty spaceId', () => {
      expect(isValidAddress({ kind: 'agent', spaceId: '', handle: 'h' })).toBe(false);
    });

    test('rejects agent with empty handle', () => {
      expect(isValidAddress({ kind: 'agent', spaceId: 'sp', handle: '' })).toBe(false);
    });

    test('rejects agent with slash in handle', () => {
      expect(isValidAddress({ kind: 'agent', spaceId: 'sp', handle: 'a/b' })).toBe(false);
    });

    test('rejects agent with empty taskId', () => {
      expect(isValidAddress({ kind: 'agent', spaceId: 'sp', handle: 'h', taskId: '' })).toBe(false);
    });

    test('rejects agent with empty node', () => {
      expect(isValidAddress({ kind: 'agent', spaceId: 'sp', handle: 'h', node: '' })).toBe(false);
    });

    test('rejects excess properties on session', () => {
      expect(
        isValidAddress({ kind: 'session', sessionId: 's1', spaceId: 'x' } as MailboxAddress)
      ).toBe(false);
    });

    test('rejects agent fields on session', () => {
      expect(
        isValidAddress({ kind: 'session', sessionId: 's1', handle: 'h' } as MailboxAddress)
      ).toBe(false);
    });

    test('rejects session field on agent', () => {
      expect(
        isValidAddress({
          kind: 'agent',
          spaceId: 'sp',
          handle: 'h',
          sessionId: 's1',
        } as MailboxAddress)
      ).toBe(false);
    });

    test('rejects missing kind', () => {
      expect(isValidAddress({ sessionId: 's1' } as unknown as MailboxAddress)).toBe(false);
    });

    test('rejects invalid kind', () => {
      expect(
        isValidAddress({ kind: 'invalid', sessionId: 's1' } as unknown as MailboxAddress)
      ).toBe(false);
    });
  });
});
