import { describe, expect, test } from 'bun:test';
import type { EventInterest } from '@hyperneo/shared';
import {
  buildPrEventTopicPattern,
  parsePrUrl,
  resolveTopicFromInterest,
} from '../../../../src/lib/space/runtime/parse-pr-url';
import { validateGlobPattern } from '../../../../src/lib/external-events/topic-validator';

describe('parsePrUrl', () => {
  test('parses a canonical github.com PR URL', () => {
    expect(parsePrUrl('https://github.com/lsm/neokai/pull/42')).toEqual({
      host: 'github.com',
      owner: 'lsm',
      repo: 'neokai',
      number: '42',
    });
  });

  test('parses a PR URL with trailing path suffix (/files, /commits, /reviews)', () => {
    expect(parsePrUrl('https://github.com/lsm/neokai/pull/42/files')).toEqual({
      host: 'github.com',
      owner: 'lsm',
      repo: 'neokai',
      number: '42',
    });
    expect(parsePrUrl('https://github.com/lsm/neokai/pull/42/commits/abc')).toEqual({
      host: 'github.com',
      owner: 'lsm',
      repo: 'neokai',
      number: '42',
    });
  });

  test('parses a GitHub Enterprise PR URL', () => {
    expect(parsePrUrl('https://github.example.com/team/repo/pull/99')).toEqual({
      host: 'github.example.com',
      owner: 'team',
      repo: 'repo',
      number: '99',
    });
  });

  test('parses an http (non-TLS) PR URL', () => {
    expect(parsePrUrl('http://github.internal/team/repo/pull/7')).toEqual({
      host: 'github.internal',
      owner: 'team',
      repo: 'repo',
      number: '7',
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

describe('buildPrEventTopicPattern', () => {
  test('builds the github PR event glob pattern for matching reactions and reviews', () => {
    const parsed = parsePrUrl('https://github.com/lsm/neokai/pull/42')!;
    expect(buildPrEventTopicPattern(parsed)).toBe('github/lsm/neokai/pull_request/42.*');
  });

  test('preserves Enterprise host-relative topic namespace', () => {
    // Topic patterns strip the host: subscriptions are namespaced under the
    // `github/` source prefix regardless of github.com vs. GHE.
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
    // A resolved topic must be a valid glob the trie can register.
    expect(validateGlobPattern(resolved!).valid).toBe(true);
  });

  test('resolves an Enterprise PR URL into the host-agnostic github/ taxonomy', () => {
    // GitHub events are published under the literal `github/` source prefix
    // regardless of github.com vs. GHE, so an Enterprise PR resolves the same
    // way as github.com (host is not part of the topic).
    const interest: Pick<EventInterest, 'topicFrom'> = {
      topicFrom: {
        source: 'primaryLink',
        pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
      },
    };
    expect(resolveTopicFromInterest(interest, 'https://github.example.com/team/repo/pull/99')).toBe(
      'github/team/repo/pull_request/99.*'
    );
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
      'https://github.example.com/team/repo/pull/99'
    );
    // `{host}` is left as a literal token rather than expanded — the GitHub
    // topic taxonomy has no host segment, so expanding it could never match.
    expect(resolved).toBe('{host}/team/repo/pull_request/99.*');
    expect(validateGlobPattern(resolved!).valid).toBe(false);
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
    // An unresolved placeholder leaves `{`/`}` in the topic, which the trie
    // rejects — surfacing the caller's malformed template at registration.
    expect(validateGlobPattern(resolved!).valid).toBe(false);
  });

  test('returns null when the interest has no topicFrom (static topic)', () => {
    // A static-topic interest carries no topicFrom — there is nothing to resolve.
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
    // A wildcard owner/repo must not expand into a wildcard subscription (the
    // trie treats `*` as match-all), and template syntax in a component must
    // not be re-interpreted by the sequential placeholder substitution.
    expect(
      resolveTopicFromInterest(primaryLinkInterest, 'https://github.com/*/*/pull/42')
    ).toBeNull();
    // owner `{repo}` would otherwise be substituted in, then re-scanned by the
    // `{repo}` pass — collapsing owner and repo to the same value (wrong repo).
    expect(
      resolveTopicFromInterest(primaryLinkInterest, 'https://github.com/{repo}/victim/pull/42')
    ).toBeNull();
  });
});
