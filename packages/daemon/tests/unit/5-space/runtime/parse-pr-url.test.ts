import { describe, expect, test } from 'bun:test';
import type { EventInterest } from '@hyperneo/shared';
import {
  buildPrEventTopicPattern,
  githubGraphqlArgs,
  githubUrlKey,
  parseGitHubRefUrl,
  parseGitHubTopic,
  pullRequestNumbersOfTopics,
  parsePrUrl,
  resolveTopicFromInterest,
} from '../../../../src/lib/github/parse-pr-url';
import { composeLongHorizonSubscriptionPattern } from '../../../../src/lib/external-events/long-horizon-subscription-pattern';
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

describe('parseGitHubTopic', () => {
  test.each([
    [
      'github/Acme/Widgets/pull_request/7.closed',
      { owner: 'Acme', repo: 'Widgets', resource: 'pull_request', entity: '7', action: 'closed' },
    ],
    [
      'github/acme/widgets/pull_request/*.review_*',
      { owner: 'acme', repo: 'widgets', resource: 'pull_request', entity: '*', action: 'review_*' },
    ],
    [
      'github/acme/widgets/pull_request/7',
      { owner: 'acme', repo: 'widgets', resource: 'pull_request', entity: '7', action: '' },
    ],
    [
      'github/acme/widgets',
      { owner: 'acme', repo: 'widgets', resource: '', entity: '', action: '' },
    ],
    ['github/acme', null],
    ['space/acme/widgets/pull_request/7.closed', null],
  ] as const)('%s', (topic, expected) => {
    expect(parseGitHubTopic(topic)).toEqual(expected);
  });
});

describe('pullRequestNumbersOfTopics', () => {
  test('returns the numbered pull requests subscribed on one repo, in any case', () => {
    expect(
      pullRequestNumbersOfTopics(
        [
          'github/Acme/Widgets/pull_request/7.*',
          'github/acme/widgets/pull_request/7.review_*',
          'github/acme/widgets/pull_request/*.check_failed',
          'github/acme/other/pull_request/8.*',
          'github/acme/widgets/repo/9.*',
          'github/acme/widgets/pull_request/12.closed',
        ],
        'acme',
        'widgets'
      )
    ).toEqual([7, 12]);
  });

  test('reads an agent subscription stored in owner/repo shorthand once composed', () => {
    expect(
      pullRequestNumbersOfTopics(
        [composeLongHorizonSubscriptionPattern('github', 'acme/widgets/pull_request/42.*')],
        'acme',
        'widgets'
      )
    ).toEqual([42]);
  });
});

describe('parseGitHubRefUrl', () => {
  test('reads pull request and issue URLs, and nothing else', () => {
    expect(parseGitHubRefUrl('https://github.com/lsm/HyperNeo/pull/6403')).toEqual({
      owner: 'lsm',
      repo: 'HyperNeo',
      number: 6403,
    });
    expect(parseGitHubRefUrl('https://github.com/lsm/HyperNeo/issues/6230#top')).toEqual({
      owner: 'lsm',
      repo: 'HyperNeo',
      number: 6230,
    });
    expect(parseGitHubRefUrl('https://github.com/lsm/HyperNeo/commit/abc')).toBe(null);
  });
});

describe('githubUrlKey', () => {
  test('compares GitHub URLs without regard to case', () => {
    expect(githubUrlKey('https://github.com/LSM/HyperNeo/pull/1')).toBe(
      githubUrlKey('https://github.com/lsm/hyperneo/pull/1')
    );
  });
});

describe('githubGraphqlArgs', () => {
  test('passes owner, name and number as GraphQL variables', () => {
    expect(githubGraphqlArgs('query{x}', { owner: 'lsm', repo: 'HyperNeo', number: 7 })).toEqual([
      'gh',
      'api',
      'graphql',
      '-f',
      'query=query{x}',
      '-f',
      'o=lsm',
      '-f',
      'n=HyperNeo',
      '-F',
      'p=7',
    ]);
  });
});
