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
