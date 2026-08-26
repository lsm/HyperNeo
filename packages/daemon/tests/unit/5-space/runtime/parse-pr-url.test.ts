import { describe, expect, test } from 'bun:test';
import type { EventInterest } from '@hyperneo/shared';
import {
  buildPrEventTopicPattern,
  buildPrUrl,
  parsePrUrl,
  resolveTopicFromInterest,
} from '../../../../src/lib/space/runtime/parse-pr-url';
import { validateGlobPattern } from '../../../../src/lib/external-events/topic-validator';

describe('parsePrUrl', () => {
  test('parses a canonical github.com PR URL', () => {
    expect(parsePrUrl('https://github.com/lsm/neokai/pull/42')).toEqual({
      scheme: 'https',
      host: 'github.com',
      owner: 'lsm',
      repo: 'neokai',
      number: '42',
    });
  });

  test('parses a PR URL with trailing path suffix (/files, /commits, /reviews)', () => {
    expect(parsePrUrl('https://github.com/lsm/neokai/pull/42/files')).toEqual({
      scheme: 'https',
      host: 'github.com',
      owner: 'lsm',
      repo: 'neokai',
      number: '42',
    });
    expect(parsePrUrl('https://github.com/lsm/neokai/pull/42/commits/abc')).toEqual({
      scheme: 'https',
      host: 'github.com',
      owner: 'lsm',
      repo: 'neokai',
      number: '42',
    });
  });

  test('parses a GitHub Enterprise PR URL', () => {
    expect(parsePrUrl('https://github.example.com/team/repo/pull/99')).toEqual({
      scheme: 'https',
      host: 'github.example.com',
      owner: 'team',
      repo: 'repo',
      number: '99',
    });
  });

  test('parses an http (non-TLS) PR URL', () => {
    expect(parsePrUrl('http://github.internal/team/repo/pull/7')).toEqual({
      scheme: 'http',
      host: 'github.internal',
      owner: 'team',
      repo: 'repo',
      number: '7',
    });
  });

  test('extracts a PR URL from surrounding prose and punctuation', () => {
    expect(parsePrUrl('Review https://github.com/lsm/neokai/pull/42')).toEqual({
      scheme: 'https',
      host: 'github.com',
      owner: 'lsm',
      repo: 'neokai',
      number: '42',
    });
    expect(parsePrUrl('See https://github.com/lsm/neokai/pull/42.')).toEqual({
      scheme: 'https',
      host: 'github.com',
      owner: 'lsm',
      repo: 'neokai',
      number: '42',
    });
    expect(parsePrUrl('Follow https://github.com/lsm/neokai/pull/42, then check the CI.')).toEqual({
      scheme: 'https',
      host: 'github.com',
      owner: 'lsm',
      repo: 'neokai',
      number: '42',
    });
  });

  test('returns null for non-PR GitHub URLs (issue, commit, repo root)', () => {
    expect(parsePrUrl('https://github.com/lsm/neokai/issues/42')).toBeNull();
    expect(parsePrUrl('https://github.com/lsm/neokai/commit/abc123')).toBeNull();
    expect(parsePrUrl('https://github.com/lsm/neokai')).toBeNull();
  });

  test('returns null for non-github URLs and malformed input', () => {
    expect(parsePrUrl('https://example.com/path/to/thing')).toBeNull();
    expect(parsePrUrl('not a url')).toBeNull();
    expect(parsePrUrl('')).toBeNull();
    expect(parsePrUrl('https://github.com/lsm/neokai/pull/notanumber')).toBeNull();
  });
});

describe('buildPrUrl', () => {
  test('rebuilds the canonical PR URL preserving scheme', () => {
    const parsed = parsePrUrl('http://github.internal/team/repo/pull/7')!;
    expect(buildPrUrl(parsed)).toBe('http://github.internal/team/repo/pull/7');
  });

  test('rebuilds an https PR URL', () => {
    const parsed = parsePrUrl('https://github.com/lsm/neokai/pull/42')!;
    expect(buildPrUrl(parsed)).toBe('https://github.com/lsm/neokai/pull/42');
  });
});

describe('buildPrEventTopicPattern', () => {
  test('builds the github PR event glob pattern for matching reactions and reviews', () => {
    const parsed = parsePrUrl('https://github.com/lsm/neokai/pull/42')!;
    expect(buildPrEventTopicPattern(parsed)).toBe('github/lsm/neokai/pull_request/42.*');
  });

  test('preserves Enterprise host-relative topic namespace', () => {
    const parsed = parsePrUrl('https://github.example.com/team/repo/pull/99')!;
    expect(buildPrEventTopicPattern(parsed)).toBe('github/team/repo/pull_request/99.*');
  });
});

describe('resolveTopicFromInterest', () => {
  const primaryLinkInterest: Pick<EventInterest, 'topicFrom'> = {
    topicFrom: {
      source: 'primaryLink',
      pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
    },
  };

  test('resolves a primaryLink pattern from a canonical github.com PR URL', () => {
    const resolved = resolveTopicFromInterest(
      primaryLinkInterest,
      'https://github.com/lsm/neokai/pull/42'
    );
    expect(resolved).toBe('github/lsm/neokai/pull_request/42.*');
    expect(validateGlobPattern(resolved!).valid).toBe(true);
  });

  test('resolves an Enterprise PR URL into the host-agnostic github/ taxonomy', () => {
    const interest: Pick<EventInterest, 'topicFrom'> = {
      topicFrom: {
        source: 'primaryLink',
        pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
      },
    };
    expect(
      resolveTopicFromInterest(
        interest,
        'https://github.example.com/team/repo/pull/99',
        new Set(['github.com', 'github.example.com'])
      )
    ).toBe('github/team/repo/pull_request/99.*');
  });

  test('does not substitute {host} (unsupported: events are published host-agnostic)', () => {
    const interest: Pick<EventInterest, 'topicFrom'> = {
      topicFrom: {
        source: 'primaryLink',
        pattern: '{host}/{owner}/{repo}/pull_request/{number}.*',
      },
    };
    const resolved = resolveTopicFromInterest(
      interest,
      'https://github.example.com/team/repo/pull/99',
      new Set(['github.com', 'github.example.com'])
    );
    expect(resolved).toBe('{host}/team/repo/pull_request/99.*');
    expect(validateGlobPattern(resolved!).valid).toBe(false);
  });

  test('returns null for a primary link on an untrusted host', () => {
    expect(
      resolveTopicFromInterest(primaryLinkInterest, 'https://evil.example/acme/widgets/pull/7')
    ).toBeNull();
    expect(
      resolveTopicFromInterest(
        primaryLinkInterest,
        'https://evil.example/acme/widgets/pull/7',
        new Set(['github.com', 'evil.example'])
      )
    ).toBe('github/acme/widgets/pull_request/7.*');
  });

  test('normalizes host case and port before the allowedHosts check (mirrors new URL().hostname)', () => {
    expect(
      resolveTopicFromInterest(primaryLinkInterest, 'https://GitHub.com/lsm/neokai/pull/42')
    ).toBe('github/lsm/neokai/pull_request/42.*');
    expect(
      resolveTopicFromInterest(
        primaryLinkInterest,
        'https://ghe.example:8443/team/repo/pull/9',
        new Set(['github.com', 'ghe.example'])
      )
    ).toBe('github/team/repo/pull_request/9.*');
    expect(
      resolveTopicFromInterest(
        primaryLinkInterest,
        'https://ghe.example/team/repo/pull/9',
        new Set(['GHE.EXAMPLE:8443'])
      )
    ).toBe('github/team/repo/pull_request/9.*');
  });

  test('only substitutes the known placeholders; unknown tokens are left as-is', () => {
    const interest: Pick<EventInterest, 'topicFrom'> = {
      topicFrom: {
        source: 'primaryLink',
        pattern: 'github/{owner}/{repo}/pull_request/{number}/{action}.x',
      },
    };
    const resolved = resolveTopicFromInterest(interest, 'https://github.com/lsm/neokai/pull/42');
    expect(resolved).toBe('github/lsm/neokai/pull_request/42/{action}.x');
    expect(validateGlobPattern(resolved!).valid).toBe(false);
  });

  test('returns null when the interest has no topicFrom (static topic)', () => {
    expect(resolveTopicFromInterest({}, 'https://github.com/lsm/neokai/pull/42')).toBeNull();
  });

  test('returns null for a malformed, non-PR, or empty URL', () => {
    expect(resolveTopicFromInterest(primaryLinkInterest, 'not a url')).toBeNull();
    expect(
      resolveTopicFromInterest(primaryLinkInterest, 'https://github.com/lsm/neokai/issues/42')
    ).toBeNull();
    expect(resolveTopicFromInterest(primaryLinkInterest, '')).toBeNull();
    expect(resolveTopicFromInterest(primaryLinkInterest, undefined)).toBeNull();
    expect(resolveTopicFromInterest(primaryLinkInterest, null)).toBeNull();
  });

  test('returns null for an unknown topicFrom source', () => {
    const interest = {
      topicFrom: {
        source: 'taskField',
        pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
      },
    } as Pick<EventInterest, 'topicFrom'>;
    expect(resolveTopicFromInterest(interest, 'https://github.com/lsm/neokai/pull/42')).toBeNull();
  });

  test('returns null when a substituted identity component is not a literal segment', () => {
    expect(
      resolveTopicFromInterest(primaryLinkInterest, 'https://github.com/*/*/pull/42')
    ).toBeNull();
    expect(
      resolveTopicFromInterest(primaryLinkInterest, 'https://github.com/{repo}/victim/pull/42')
    ).toBeNull();
  });
});
