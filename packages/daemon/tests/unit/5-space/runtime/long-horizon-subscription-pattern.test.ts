import { describe, expect, test } from 'bun:test';
import { composeLongHorizonSubscriptionPattern } from '../../../../src/lib/external-events/long-horizon-subscription-pattern';

describe('composeLongHorizonSubscriptionPattern', () => {
  describe('empty source returns the trimmed topic unchanged', () => {
    test('empty source', () => {
      expect(composeLongHorizonSubscriptionPattern('', 'foo/bar')).toBe('foo/bar');
    });
    test('whitespace-only source and topic are both trimmed', () => {
      expect(composeLongHorizonSubscriptionPattern('   ', '  hello/world  ')).toBe('hello/world');
    });
  });

  describe('github source delegates to the GitHub topic grammar', () => {
    test('owner/repo/resource shorthand widens the entity to a wildcard', () => {
      expect(composeLongHorizonSubscriptionPattern('github', 'owner/repo/pull_request')).toBe(
        'github/owner/repo/pull_request/*'
      );
    });
    test('owner/repo/resource.action shorthand is fully qualified', () => {
      expect(
        composeLongHorizonSubscriptionPattern('github', 'owner/repo/pull_request/42.opened')
      ).toBe('github/owner/repo/pull_request/42.opened');
    });
    test('a source-prefixed fully-qualified topic is returned unchanged', () => {
      expect(
        composeLongHorizonSubscriptionPattern('github', 'github/owner/repo/pull_request/42.opened')
      ).toBe('github/owner/repo/pull_request/42.opened');
    });
    test('a non-shorthand github topic with an unknown topic source still delegates', () => {
      expect(composeLongHorizonSubscriptionPattern('github', 'pull_request')).toBe(
        'github/*/*/pull_request/*'
      );
    });
  });

  describe('non-github source whose topic already starts with the source', () => {
    test('returns the topic unchanged', () => {
      expect(composeLongHorizonSubscriptionPattern('space', 'space/some/event')).toBe(
        'space/some/event'
      );
    });
  });

  describe('known-source mismatch throws', () => {
    test('space source with a github-prefixed topic', () => {
      expect(() => composeLongHorizonSubscriptionPattern('space', 'github/foo/bar')).toThrow(
        'Topic source "github" does not match source "space"'
      );
    });
    test('github source with a space-prefixed topic', () => {
      expect(() => composeLongHorizonSubscriptionPattern('github', 'space/foo')).toThrow(
        'Topic source "space" does not match source "github"'
      );
    });
    test('a case-only mismatch still throws (matching is case-insensitive)', () => {
      expect(() => composeLongHorizonSubscriptionPattern('Space', 'space/foo')).toThrow(
        'Topic source "space" does not match source "Space"'
      );
    });
  });

  describe('generic non-github source joins as source/topic', () => {
    test('lowercase source', () => {
      expect(composeLongHorizonSubscriptionPattern('crm', 'leads/new')).toBe('crm/leads/new');
    });
    test('mixed-case source and topic are preserved verbatim', () => {
      expect(composeLongHorizonSubscriptionPattern('jira', 'PROJ-123/updated')).toBe(
        'jira/PROJ-123/updated'
      );
    });
  });
});
