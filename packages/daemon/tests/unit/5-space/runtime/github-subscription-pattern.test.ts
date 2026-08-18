import { describe, expect, test } from 'bun:test';
import {
  composeGitHubSubscriptionPattern,
  legacyGitHubTopic,
} from '../../../../src/lib/external-events/github-subscription-pattern';

describe('composeGitHubSubscriptionPattern', () => {
  describe('fully-qualified source-prefixed topic (5 segments)', () => {
    test('returns the topic unchanged when resource and action are valid', () => {
      expect(
        composeGitHubSubscriptionPattern('github', 'github/owner/repo/pull_request/42.opened')
      ).toBe('github/owner/repo/pull_request/42.opened');
    });
  });

  describe('owner/repo/resource/action shorthand (4 resource segments)', () => {
    test('prepends the source', () => {
      expect(composeGitHubSubscriptionPattern('github', 'owner/repo/pull_request/42.opened')).toBe(
        'github/owner/repo/pull_request/42.opened'
      );
    });
  });

  describe('source-prefixed, 3 resource segments', () => {
    test('first segment is the resource → widens owner/repo to wildcards', () => {
      expect(composeGitHubSubscriptionPattern('github', 'github/pull_request/42.opened')).toBe(
        'github/*/*/pull_request/42.opened'
      );
    });
    test('second segment is the resource → echoes source as owner/repo', () => {
      expect(composeGitHubSubscriptionPattern('github', 'github/foo/pull_request/*')).toBe(
        'github/github/foo/pull_request/*'
      );
    });
  });

  describe('owner/repo/resource shorthand (3 resource segments, not source-prefixed)', () => {
    test('dotted resource → widens entity id to wildcard', () => {
      expect(composeGitHubSubscriptionPattern('github', 'owner/repo/pull_request.opened')).toBe(
        'github/owner/repo/pull_request/*.opened'
      );
    });
    test('known bare resource → widens entity to wildcard', () => {
      expect(composeGitHubSubscriptionPattern('github', 'owner/repo/pull_request')).toBe(
        'github/owner/repo/pull_request/*'
      );
    });
  });

  describe('2 resource segments', () => {
    test('source-prefixed, dotted entity action → splits resource out of the action', () => {
      expect(composeGitHubSubscriptionPattern('github', 'github/foo/pull_request.opened')).toBe(
        'github/github/foo/pull_request/*.opened'
      );
    });
    test('source-prefixed, second segment is the resource → echoes source as owner/repo', () => {
      expect(composeGitHubSubscriptionPattern('github', 'github/foo/pull_request')).toBe(
        'github/github/foo/pull_request/*'
      );
    });
    test('known resource + dotted action → widens owner/repo to wildcards', () => {
      expect(composeGitHubSubscriptionPattern('github', 'pull_request/42.opened')).toBe(
        'github/*/*/pull_request/42.opened'
      );
    });
  });

  describe('single resource segment', () => {
    test('dotted resource → widens owner/repo and entity id to wildcards', () => {
      expect(composeGitHubSubscriptionPattern('github', 'pull_request.opened')).toBe(
        'github/*/*/pull_request/*.opened'
      );
    });
    test('known bare resource → widens owner/repo and entity to wildcards', () => {
      expect(composeGitHubSubscriptionPattern('github', 'pull_request')).toBe(
        'github/*/*/pull_request/*'
      );
    });
  });

  test('source-only topic falls through to the catch-all pattern', () => {
    expect(composeGitHubSubscriptionPattern('github', 'github')).toBe('github/*/*/github');
  });

  describe('error cases', () => {
    test('rejects slash-separated action on a source-prefixed 6-segment topic', () => {
      expect(() =>
        composeGitHubSubscriptionPattern('github', 'github/owner/repo/pull_request/42/closed')
      ).toThrow('must use dotted entity actions like "pull_request/42.closed"');
    });
    test('rejects slash-separated action on an unprefixed 5-segment topic', () => {
      expect(() =>
        composeGitHubSubscriptionPattern('github', 'owner/repo/pull_request/42/closed')
      ).toThrow('must use dotted entity actions like "pull_request/42.closed"');
    });
    test('rejects topics with more than 4 resource segments', () => {
      expect(() => composeGitHubSubscriptionPattern('github', 'a/b/c/d/e/f')).toThrow(
        'must match supported shape "owner/repo/pull_request/<id>.<action>"'
      );
    });
    test('rejects unsupported resources (supported: pull_request, repo)', () => {
      expect(() =>
        composeGitHubSubscriptionPattern('github', 'github/owner/repo/issues/42.opened')
      ).toThrow('uses unsupported resource "issues"; supported resources: pull_request, repo');
    });
    test('rejects a bare action with no dotted entity on a source-prefixed 3-segment topic', () => {
      expect(() =>
        composeGitHubSubscriptionPattern('github', 'github/foo/pull_request/opened')
      ).toThrow('must use dotted entity actions like "pull_request/42.opened"');
    });
    test('rejects an unknown bare resource on an owner/repo/resource topic', () => {
      expect(() => composeGitHubSubscriptionPattern('github', 'owner/repo/issues')).toThrow(
        'must use dotted entity actions like "pull_request/42.closed"'
      );
    });
    test('rejects a 2-segment unprefixed topic with no resource segment', () => {
      expect(() => composeGitHubSubscriptionPattern('github', 'foo/bar')).toThrow(
        'must include a resource segment like "owner/repo/pull_request"'
      );
    });
    test('rejects a single unknown segment', () => {
      expect(() => composeGitHubSubscriptionPattern('github', 'something')).toThrow(
        'uses unsupported resource "something"; supported resources: pull_request'
      );
    });
  });
});

describe('repo resource (branch_protection_rule, spec row 7)', () => {
  test('accepts the repo resource in a fully-qualified 5-segment topic', () => {
    expect(
      composeGitHubSubscriptionPattern(
        'github',
        'github/acme/widgets/repo/main.branch_protection_created'
      )
    ).toBe('github/acme/widgets/repo/main.branch_protection_created');
  });
  test('accepts the repo resource in the owner/repo/resource.action shorthand', () => {
    expect(
      composeGitHubSubscriptionPattern('github', 'acme/widgets/repo/main.branch_protection_edited')
    ).toBe('github/acme/widgets/repo/main.branch_protection_edited');
  });
  test('owner literally named "repo" expands owner/repo/resource (bare third), not resource-first', () => {
    expect(composeGitHubSubscriptionPattern('github', 'github/repo/widgets/pull_request')).toBe(
      'github/repo/widgets/pull_request/*'
    );
  });
  test('owner literally named "repo" expands owner/repo/resource.action (dotted third)', () => {
    expect(
      composeGitHubSubscriptionPattern(
        'github',
        'github/repo/widgets/repo.branch_protection_edited'
      )
    ).toBe('github/repo/widgets/repo/*.branch_protection_edited');
  });
  test('resource-first shorthand allows a resource-named entity (branch "pull_request")', () => {
    expect(
      composeGitHubSubscriptionPattern(
        'github',
        'github/repo/pull_request/branch_protection_created'
      )
    ).toBe('github/*/*/repo/pull_request.branch_protection_created');
  });
});

describe('legacyGitHubTopic', () => {
  test('rewrites a legacy 5-segment dotted topic to the resource.action form', () => {
    expect(legacyGitHubTopic('github/src/owner/repo/pull_request.closed')).toBe(
      'github/src/owner/repo.closed'
    );
  });
  test('slices at the first dot in the entity segment', () => {
    expect(legacyGitHubTopic('github/a/b/c/d.e.f')).toBe('github/a/b/c.e.f');
  });
  test('returns null when the entity segment has no dot', () => {
    expect(legacyGitHubTopic('github/a/b/c/d')).toBeNull();
  });
  test('returns null when the topic is not a 5-segment github topic', () => {
    expect(legacyGitHubTopic('notgithub/a/b/c/d.e')).toBeNull();
  });
});
