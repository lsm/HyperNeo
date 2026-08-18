import { describe, expect, test } from 'bun:test';
import {
  isReservedAgentHandle,
  normalizeAgentNameToken,
  normalizeReplyTargetHandle,
} from '../../../src/lib/space/agent-handle';

describe('normalizeAgentNameToken', () => {
  test('lowercases the value', () => {
    expect(normalizeAgentNameToken('Coder')).toBe('coder');
    expect(normalizeAgentNameToken('MixedCase')).toBe('mixedcase');
  });
  test('trims surrounding whitespace', () => {
    expect(normalizeAgentNameToken('  coder  ')).toBe('coder');
    expect(normalizeAgentNameToken('\tReviewer\n')).toBe('reviewer');
  });
  test('trims and lowercases together', () => {
    expect(normalizeAgentNameToken('  My Agent  ')).toBe('my agent');
  });
  test('preserves interior whitespace and punctuation (only trim + lowercase)', () => {
    expect(normalizeAgentNameToken('Agent 42')).toBe('agent 42');
    expect(normalizeAgentNameToken('a@b')).toBe('a@b');
  });
  test('empty and whitespace-only input collapse to empty string', () => {
    expect(normalizeAgentNameToken('')).toBe('');
    expect(normalizeAgentNameToken('   ')).toBe('');
  });
  test('is an identity for already-normalized input', () => {
    expect(normalizeAgentNameToken('coder')).toBe('coder');
  });
});

describe('normalizeReplyTargetHandle', () => {
  test('returns null for empty input', () => {
    expect(normalizeReplyTargetHandle('')).toBeNull();
  });
  test('returns null for whitespace-only input', () => {
    expect(normalizeReplyTargetHandle('   ')).toBeNull();
    expect(normalizeReplyTargetHandle('\t')).toBeNull();
  });
  test('maps the literal "space-agent" to the synthetic @coordinator', () => {
    expect(normalizeReplyTargetHandle('space-agent')).toBe('@coordinator');
  });
  test('maps "space-agent" after trimming', () => {
    expect(normalizeReplyTargetHandle('  space-agent  ')).toBe('@coordinator');
  });
  test('does NOT treat a prefixed/embedded "space-agent" as the coordinator', () => {
    expect(normalizeReplyTargetHandle('space-agent-2')).toBe('@space-agent-2');
  });

  describe('already @-prefixed values pass through verbatim (trim only)', () => {
    test('returns an @-prefixed value as-is', () => {
      expect(normalizeReplyTargetHandle('@coder')).toBe('@coder');
    });
    test('trims surrounding whitespace but preserves the rest unchanged', () => {
      expect(normalizeReplyTargetHandle('  @Foo  ')).toBe('@Foo');
    });
    test('does NOT lowercase or slugify @-prefixed values', () => {
      expect(normalizeReplyTargetHandle('@Mixed_Case!')).toBe('@Mixed_Case!');
    });
    test('a bare "@" passes through as "@"', () => {
      expect(normalizeReplyTargetHandle('@')).toBe('@');
    });
  });

  describe('non-@-prefixed names are slugified into @handles (handleFromName)', () => {
    test('lowercases and prefixes a simple name', () => {
      expect(normalizeReplyTargetHandle('Coder')).toBe('@coder');
    });
    test('collapses runs of non-[a-z0-9_-] chars to a single hyphen', () => {
      expect(normalizeReplyTargetHandle('My Agent')).toBe('@my-agent');
      expect(normalizeReplyTargetHandle('My!!! Agent')).toBe('@my-agent');
    });
    test('preserves underscores and hyphens', () => {
      expect(normalizeReplyTargetHandle('foo_bar-baz')).toBe('@foo_bar-baz');
    });
    test('preserves digits', () => {
      expect(normalizeReplyTargetHandle('Agent 42')).toBe('@agent-42');
    });
    test('strips leading/trailing hyphens left by edge punctuation', () => {
      expect(normalizeReplyTargetHandle('-Foo-')).toBe('@foo');
      expect(normalizeReplyTargetHandle('!!foo!!')).toBe('@foo');
    });
    test('returns null when the name slugifies to empty', () => {
      expect(normalizeReplyTargetHandle('!!!')).toBeNull();
    });
    test('a leading "@" short-circuits slugification — even "@@@" passes through', () => {
      expect(normalizeReplyTargetHandle('@@@')).toBe('@@@');
    });
  });
});

describe('isReservedAgentHandle', () => {
  test.each([
    'coordinator',
    'system-runtime',
    'system-workflow',
    'system-messaging',
  ])('returns true for the reserved singleton %s', (handle) => {
    expect(isReservedAgentHandle(handle)).toBe(true);
  });
  test('returns false for an ordinary agent handle', () => {
    expect(isReservedAgentHandle('coder')).toBe(false);
    expect(isReservedAgentHandle('reviewer')).toBe(false);
  });
  test('returns false for the empty string', () => {
    expect(isReservedAgentHandle('')).toBe(false);
  });
  test('is case-sensitive (callers must pass already-normalized handles)', () => {
    expect(isReservedAgentHandle('Coordinator')).toBe(false);
    expect(isReservedAgentHandle('COORDINATOR')).toBe(false);
  });
  test('does not match a reserved handle embedded in a longer string', () => {
    expect(isReservedAgentHandle('coordinator-2')).toBe(false);
    expect(isReservedAgentHandle('system-runtime-backup')).toBe(false);
  });
});
