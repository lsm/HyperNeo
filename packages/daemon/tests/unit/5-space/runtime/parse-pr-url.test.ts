import { describe, expect, test } from 'bun:test';
import {
  buildPrEventTopicPattern,
  parsePrUrl,
} from '../../../../src/lib/space/runtime/parse-pr-url';

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
