import { describe, expect, test } from 'bun:test';
import {
  isValidAddress,
  parseAddress,
  renderAddress,
  type MailboxAddress,
} from '../../../../src/lib/space/mailbox/address';

const VALID_SAMPLES: MailboxAddress[] = [
  { kind: 'session', sessionId: 'sess-1' },
  { kind: 'session', sessionId: 'a b/c?d=e&f#g' },
  { kind: 'agent', spaceId: 'sp-1', handle: 'coder' },
  { kind: 'agent', spaceId: 'sp-1', handle: 'coder', taskId: '1725' },
  { kind: 'agent', spaceId: 'sp-1', handle: 'coder', node: 'Coding' },
  { kind: 'agent', spaceId: 'sp-1', handle: 'coder', taskId: '1725', node: 'Coding' },
  { kind: 'agent', spaceId: 'sp/1', handle: 'co der' },
  { kind: 'agent', spaceId: 'sp-1', handle: 'coder', taskId: 'a&b=c?d#e%f' },
  { kind: 'agent', spaceId: 'sp-1', handle: 'review:er?', node: 'Nø de' },
  { kind: 'agent', spaceId: 'sp-1', handle: '😀', taskId: '🚀', node: 'Coding' },
];

function asAddress(value: unknown): MailboxAddress {
  return value as MailboxAddress;
}

describe('parseAddress', () => {
  test('parses a session address', () => {
    expect(parseAddress('session:sess-1')).toEqual({ kind: 'session', sessionId: 'sess-1' });
  });

  test('parses an agent address without optional fields', () => {
    expect(parseAddress('agent:sp-1/coder')).toEqual({
      kind: 'agent',
      spaceId: 'sp-1',
      handle: 'coder',
    });
  });

  test('parses an agent address with task', () => {
    expect(parseAddress('agent:sp-1/coder?task=1725')).toEqual({
      kind: 'agent',
      spaceId: 'sp-1',
      handle: 'coder',
      taskId: '1725',
    });
  });

  test('parses an agent address with node', () => {
    expect(parseAddress('agent:sp-1/coder?node=Coding')).toEqual({
      kind: 'agent',
      spaceId: 'sp-1',
      handle: 'coder',
      node: 'Coding',
    });
  });

  test('parses an agent address with task and node', () => {
    expect(parseAddress('agent:sp-1/coder?task=1725&node=Coding')).toEqual({
      kind: 'agent',
      spaceId: 'sp-1',
      handle: 'coder',
      taskId: '1725',
      node: 'Coding',
    });
  });

  test('accepts query keys in either order', () => {
    expect(parseAddress('agent:sp-1/coder?node=Coding&task=1725')).toEqual({
      kind: 'agent',
      spaceId: 'sp-1',
      handle: 'coder',
      taskId: '1725',
      node: 'Coding',
    });
  });

  test('percent-decodes reserved characters in every segment', () => {
    expect(parseAddress('agent:sp%2F1/co%20der?task=a%26b%3Dc%3F&node=N%C3%B8%20de')).toEqual({
      kind: 'agent',
      spaceId: 'sp/1',
      handle: 'co der',
      taskId: 'a&b=c?',
      node: 'Nø de',
    });
    expect(parseAddress('session:a%20b%2Fc%3Fd%3De%26f')).toEqual({
      kind: 'session',
      sessionId: 'a b/c?d=e&f',
    });
  });

  test('rejects a handle that decodes to contain a slash', () => {
    expect(parseAddress('agent:sp-1/co%2Fder')).toBeNull();
  });

  test('rejects fields containing unpaired surrogates', () => {
    expect(parseAddress('session:\uD800')).toBeNull();
    expect(parseAddress('agent:sp-1/co\uDC00der')).toBeNull();
    expect(parseAddress('agent:sp-1/coder?task=\uD800')).toBeNull();
    expect(parseAddress('agent:sp-1/coder?node=\uDBFF')).toBeNull();
  });

  test('returns null for unknown prefixes', () => {
    expect(parseAddress('room:r-1')).toBeNull();
    expect(parseAddress('Session:sess-1')).toBeNull();
    expect(parseAddress('sessionsess-1')).toBeNull();
    expect(parseAddress('agentt:sp-1/coder')).toBeNull();
  });

  test('returns null for empty segments', () => {
    expect(parseAddress('')).toBeNull();
    expect(parseAddress('session:')).toBeNull();
    expect(parseAddress('agent:/coder')).toBeNull();
    expect(parseAddress('agent:sp-1/')).toBeNull();
    expect(parseAddress('agent:sp-1/coder?task=')).toBeNull();
    expect(parseAddress('agent:sp-1/coder?node=')).toBeNull();
  });

  test('returns null for stray slashes', () => {
    expect(parseAddress('session:sess/1')).toBeNull();
    expect(parseAddress('agent:sp-1/coder/extra')).toBeNull();
    expect(parseAddress('agent:sp-1/co/der?task=1725')).toBeNull();
    expect(parseAddress('agent:/sp-1/coder')).toBeNull();
  });

  test('returns null for invalid query syntax', () => {
    expect(parseAddress('agent:sp-1/coder?task')).toBeNull();
    expect(parseAddress('agent:sp-1/coder?task=1725&')).toBeNull();
    expect(parseAddress('agent:sp-1/coder?&task=1725')).toBeNull();
    expect(parseAddress('agent:sp-1/coder?')).toBeNull();
    expect(parseAddress('agent:sp-1/coder?task=17%25')).toEqual({
      kind: 'agent',
      spaceId: 'sp-1',
      handle: 'coder',
      taskId: '17%',
    });
    expect(parseAddress('agent:sp-1/coder?task=17%zz')).toBeNull();
    expect(parseAddress('agent:sp-1/coder?task=1725?extra')).toEqual({
      kind: 'agent',
      spaceId: 'sp-1',
      handle: 'coder',
      taskId: '1725?extra',
    });
  });

  test('returns null for unknown or duplicate query keys', () => {
    expect(parseAddress('agent:sp-1/coder?queue=high')).toBeNull();
    expect(parseAddress('agent:sp-1/coder?tasks=1725')).toBeNull();
    expect(parseAddress('agent:sp-1/coder?task=1&task=2')).toBeNull();
    expect(parseAddress('agent:sp-1/coder?node=A&node=B')).toBeNull();
    expect(parseAddress('session:sess-1?task=1725')).toBeNull();
  });
});

describe('renderAddress', () => {
  test('renders every grammar form canonically', () => {
    expect(renderAddress({ kind: 'session', sessionId: 'sess-1' })).toBe('session:sess-1');
    expect(renderAddress({ kind: 'agent', spaceId: 'sp-1', handle: 'coder' })).toBe(
      'agent:sp-1/coder'
    );
    expect(renderAddress({ kind: 'agent', spaceId: 'sp-1', handle: 'coder', taskId: '1725' })).toBe(
      'agent:sp-1/coder?task=1725'
    );
    expect(renderAddress({ kind: 'agent', spaceId: 'sp-1', handle: 'coder', node: 'Coding' })).toBe(
      'agent:sp-1/coder?node=Coding'
    );
    expect(
      renderAddress({
        kind: 'agent',
        spaceId: 'sp-1',
        handle: 'coder',
        taskId: '1725',
        node: 'Coding',
      })
    ).toBe('agent:sp-1/coder?task=1725&node=Coding');
  });

  test('emits task before node regardless of property insertion order', () => {
    const nodeFirst = asAddress({
      node: 'Coding',
      taskId: '1725',
      kind: 'agent',
      spaceId: 'sp-1',
      handle: 'coder',
    });
    expect(renderAddress(nodeFirst)).toBe('agent:sp-1/coder?task=1725&node=Coding');
  });

  test('percent-encodes reserved characters in every segment', () => {
    expect(renderAddress({ kind: 'session', sessionId: 'a b/c?d=e&f' })).toBe(
      'session:a%20b%2Fc%3Fd%3De%26f'
    );
    expect(renderAddress({ kind: 'agent', spaceId: 'sp/1', handle: 'co der' })).toBe(
      'agent:sp%2F1/co%20der'
    );
    expect(
      renderAddress({
        kind: 'agent',
        spaceId: 'sp-1',
        handle: 'coder',
        taskId: 'a&b=c?d',
        node: 'Nø de',
      })
    ).toBe('agent:sp-1/coder?task=a%26b%3Dc%3Fd&node=N%C3%B8%20de');
  });

  test('renders identical addresses to identical strings', () => {
    for (const sample of VALID_SAMPLES) {
      expect(renderAddress(sample)).toBe(renderAddress({ ...sample }));
    }
  });
});

describe('round-trip law', () => {
  test('parseAddress(renderAddress(addr)) recovers every valid sample', () => {
    for (const sample of VALID_SAMPLES) {
      expect(parseAddress(renderAddress(sample))).toEqual(sample);
    }
  });

  test('renderAddress(parseAddress(raw)) is canonical for reordered query keys', () => {
    expect(renderAddress(parseAddress('agent:sp-1/coder?node=Coding&task=1725')!)).toBe(
      'agent:sp-1/coder?task=1725&node=Coding'
    );
  });
});

describe('isValidAddress', () => {
  test('accepts every valid sample', () => {
    for (const sample of VALID_SAMPLES) {
      expect(isValidAddress(sample)).toBe(true);
    }
  });

  test('accepts parsed addresses', () => {
    for (const raw of [
      'session:sess-1',
      'agent:sp-1/coder',
      'agent:sp-1/coder?task=1725',
      'agent:sp-1/coder?node=Coding',
      'agent:sp-1/coder?task=1725&node=Coding',
    ]) {
      expect(isValidAddress(parseAddress(raw)!)).toBe(true);
    }
  });

  test('rejects an empty sessionId', () => {
    expect(isValidAddress(asAddress({ kind: 'session', sessionId: '' }))).toBe(false);
  });

  test('rejects an empty spaceId', () => {
    expect(isValidAddress(asAddress({ kind: 'agent', spaceId: '', handle: 'coder' }))).toBe(false);
  });

  test('rejects an empty handle', () => {
    expect(isValidAddress(asAddress({ kind: 'agent', spaceId: 'sp-1', handle: '' }))).toBe(false);
  });

  test('rejects a handle containing a slash', () => {
    expect(isValidAddress(asAddress({ kind: 'agent', spaceId: 'sp-1', handle: 'co/der' }))).toBe(
      false
    );
  });

  test('rejects empty taskId and node when present', () => {
    expect(
      isValidAddress(asAddress({ kind: 'agent', spaceId: 'sp-1', handle: 'coder', taskId: '' }))
    ).toBe(false);
    expect(
      isValidAddress(asAddress({ kind: 'agent', spaceId: 'sp-1', handle: 'coder', node: '' }))
    ).toBe(false);
  });

  test('rejects session addresses carrying agent fields', () => {
    expect(
      isValidAddress(asAddress({ kind: 'session', sessionId: 'sess-1', handle: 'coder' }))
    ).toBe(false);
    expect(
      isValidAddress(asAddress({ kind: 'session', sessionId: 'sess-1', taskId: '1725' }))
    ).toBe(false);
    expect(
      isValidAddress(asAddress({ kind: 'session', sessionId: 'sess-1', node: 'Coding' }))
    ).toBe(false);
    expect(
      isValidAddress(asAddress({ kind: 'session', sessionId: 'sess-1', spaceId: 'sp-1' }))
    ).toBe(false);
  });

  test('rejects agent addresses carrying session fields or unknown fields', () => {
    expect(
      isValidAddress(asAddress({ kind: 'agent', spaceId: 'sp-1', handle: 'coder', sessionId: 's' }))
    ).toBe(false);
    expect(
      isValidAddress(asAddress({ kind: 'agent', spaceId: 'sp-1', handle: 'coder', queue: 'high' }))
    ).toBe(false);
  });

  test('rejects unknown kinds and non-addresses', () => {
    expect(isValidAddress(asAddress({ kind: 'room', roomId: 'r-1' }))).toBe(false);
    expect(isValidAddress(asAddress(null))).toBe(false);
    expect(isValidAddress(asAddress('session:sess-1'))).toBe(false);
    expect(isValidAddress(asAddress([1, 2]))).toBe(false);
  });

  test('treats explicitly undefined optional fields as absent', () => {
    expect(
      isValidAddress(
        asAddress({ kind: 'agent', spaceId: 'sp-1', handle: 'coder', taskId: undefined })
      )
    ).toBe(true);
  });

  test('rejects fields containing unpaired surrogates', () => {
    expect(isValidAddress(asAddress({ kind: 'session', sessionId: '\uD800' }))).toBe(false);
    expect(isValidAddress(asAddress({ kind: 'agent', spaceId: '\uDC00', handle: 'coder' }))).toBe(
      false
    );
    expect(
      isValidAddress(asAddress({ kind: 'agent', spaceId: 'sp-1', handle: 'co\uD800der' }))
    ).toBe(false);
    expect(
      isValidAddress(
        asAddress({ kind: 'agent', spaceId: 'sp-1', handle: 'coder', taskId: '\uDBFF' })
      )
    ).toBe(false);
    expect(
      isValidAddress(asAddress({ kind: 'agent', spaceId: 'sp-1', handle: 'coder', node: '\uDFFF' }))
    ).toBe(false);
  });
});
