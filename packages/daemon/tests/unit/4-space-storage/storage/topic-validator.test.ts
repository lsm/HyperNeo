import { describe, expect, test } from 'bun:test';
import {
  KNOWN_SOURCES,
  validateGlobPattern,
  validateLiteralTopic,
  validateSource,
} from '../../../../src/lib/external-events/topic-validator';

describe('validateGlobPattern', () => {
  test('accepts 5-segment GitHub topic', () => {
    const r = validateGlobPattern('github/lsm/neokai/pull_request/5.review_submitted');
    expect(r.valid).toBe(true);
  });

  test('accepts 3-segment Slack-like topic', () => {
    const r = validateGlobPattern('slack/workspace/channel/message_created');
    expect(r.valid).toBe(true);
  });

  test('accepts segment wildcards', () => {
    const r = validateGlobPattern('github/*/*/pull_request/5.review_submitted');
    expect(r.valid).toBe(true);
  });

  test('accepts dotted-segment wildcard', () => {
    const r = validateGlobPattern('github/*/*/pull_request/5.*');
    expect(r.valid).toBe(true);
  });

  test('accepts dotted-segment partial wildcard', () => {
    const r = validateGlobPattern('github/*/*/pull_request/5.review_*');
    expect(r.valid).toBe(true);
  });

  test('rejects empty string', () => {
    const r = validateGlobPattern('');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/must not be empty/);
  });

  test('rejects single segment (no scope)', () => {
    const r = validateGlobPattern('github');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/at least 2 segments/);
  });

  test('rejects empty segment (double slash)', () => {
    const r = validateGlobPattern('github//repo/pull_request/5.opened');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/empty segments/);
  });

  test('rejects ".." segment', () => {
    const r = validateGlobPattern('github/../repo/pull_request/5.opened');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/\.\./);
  });

  test('rejects multi-segment "**" wildcard', () => {
    const r = validateGlobPattern('github/**/repo/pull_request/5.opened');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/\*\*/);
  });

  test('rejects invalid characters', () => {
    const r = validateGlobPattern('github/lsm/neokai/pull_request/5$opened');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/invalid characters/);
  });
});

describe('validateLiteralTopic', () => {
  test('accepts literal 5-segment GitHub topic', () => {
    const r = validateLiteralTopic('github/lsm/neokai/pull_request/5.review_submitted');
    expect(r.valid).toBe(true);
  });

  test('accepts literal 3-segment non-GitHub topic', () => {
    const r = validateLiteralTopic('slack/workspace/channel/message_created');
    expect(r.valid).toBe(true);
  });

  test('rejects topic with only one segment', () => {
    const r = validateLiteralTopic('github');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/at least 2 segments/);
  });

  test('rejects topic with segment wildcard', () => {
    const r = validateLiteralTopic('github/*/*/pull_request/5.opened');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/no wildcards/);
  });

  test('rejects topic with dotted-segment wildcard', () => {
    const r = validateLiteralTopic('github/lsm/neokai/pull_request/5.*');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/no wildcards/);
  });

  test('rejects topic that fails validateGlobPattern', () => {
    const r = validateLiteralTopic('github//repo/pull_request/5.opened');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/empty segments/);
  });
});

describe('validateSource', () => {
  test('accepts known source "github"', () => {
    const r = validateSource('github');
    expect(r.valid).toBe(true);
  });

  test('rejects unknown source', () => {
    const r = validateSource('slack');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not registered/);
  });

  test('rejects empty source', () => {
    const r = validateSource('');
    expect(r.valid).toBe(false);
  });

  test('rejects source starting with digit', () => {
    const r = validateSource('1github');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/must be lowercase/);
  });

  test('rejects source with uppercase', () => {
    const r = validateSource('GitHub');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/must be lowercase/);
  });

  test('rejects valid but unregistered source', () => {
    const r = validateSource('my_source-2');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not registered/);
  });
});

describe('KNOWN_SOURCES', () => {
  test('contains github', () => {
    expect(KNOWN_SOURCES.has('github')).toBe(true);
  });
});
