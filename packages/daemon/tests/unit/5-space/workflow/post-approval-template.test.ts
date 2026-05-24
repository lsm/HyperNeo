/**
 * Unit tests for `post-approval-template.ts`.
 *
 * PR 1/5 of the task-agent-as-post-approval-executor refactor. See
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §1.6, §4.6.
 */

import { describe, expect, test } from 'bun:test';
import {
  POST_APPROVAL_TEMPLATE_KEYS,
  interpolatePostApprovalTemplate,
} from '../../../../src/lib/space/workflows/post-approval-template.ts';

describe('interpolatePostApprovalTemplate — happy path', () => {
  test('renders all documented context keys', () => {
    const template =
      'Task {{task_id}} ({{task_title}}) in space {{space_id}} at {{workspace_path}}\n' +
      'Reviewer: {{reviewer_name}} via {{approval_source}} (autonomy {{autonomy_level}}).';
    const context = {
      autonomy_level: 3,
      task_id: 't-42',
      task_title: 'Ship PR',
      reviewer_name: 'reviewer',
      approval_source: 'human',
      space_id: 's-7',
      workspace_path: '/tmp/ws',
    };
    const result = interpolatePostApprovalTemplate(template, context);
    expect(result.missingKeys).toEqual([]);
    expect(result.text).toBe(
      'Task t-42 (Ship PR) in space s-7 at /tmp/ws\n' + 'Reviewer: reviewer via human (autonomy 3).'
    );
  });

  test('arbitrary context keys (e.g. end-node payload) are usable', () => {
    const template = 'merge {{pr_url}} (sha {{merge_sha}})';
    const result = interpolatePostApprovalTemplate(template, {
      pr_url: 'https://github.com/a/b/pull/1',
      merge_sha: 'deadbeef',
    });
    expect(result.text).toBe('merge https://github.com/a/b/pull/1 (sha deadbeef)');
    expect(result.missingKeys).toEqual([]);
  });

  test('POST_APPROVAL_TEMPLATE_KEYS matches the §1.6 contract', () => {
    expect([...POST_APPROVAL_TEMPLATE_KEYS]).toEqual([
      'autonomy_level',
      'task_id',
      'task_title',
      'reviewer_name',
      'approval_source',
      'space_id',
      'workspace_path',
    ]);
  });
});

describe('interpolatePostApprovalTemplate — missing keys', () => {
  test('missing key renders as the literal token and is reported', () => {
    const result = interpolatePostApprovalTemplate('merge {{pr_url}} now', {});
    expect(result.text).toBe('merge {{pr_url}} now');
    expect(result.missingKeys).toEqual(['pr_url']);
  });

  test('null / undefined values are treated as missing', () => {
    const result = interpolatePostApprovalTemplate('{{a}} {{b}}', {
      a: null,
      b: undefined,
    });
    expect(result.text).toBe('{{a}} {{b}}');
    expect(result.missingKeys).toEqual(['a', 'b']);
  });

  test('same missing key appearing multiple times reports once', () => {
    const result = interpolatePostApprovalTemplate('{{pr_url}} / {{pr_url}}', {});
    expect(result.text).toBe('{{pr_url}} / {{pr_url}}');
    expect(result.missingKeys).toEqual(['pr_url']);
  });
});

describe('interpolatePostApprovalTemplate — grammar guarantees', () => {
  test('single-pass: replacement text is not re-scanned for tokens', () => {
    // If the substitution were recursive, `{{inner}}` would be expanded
    // after replacing {{outer}}. Single-pass means the nested token stays
    // literal.
    const result = interpolatePostApprovalTemplate('{{outer}}', {
      outer: 'prefix-{{inner}}-suffix',
      inner: 'SHOULD_NOT_EXPAND',
    });
    expect(result.text).toBe('prefix-{{inner}}-suffix');
    // `{{inner}}` was produced by the substitution, not by the source —
    // so it is NOT counted as a missing key.
    expect(result.missingKeys).toEqual([]);
  });

  test('special characters in values pass through unchanged (no escaping)', () => {
    const template = 'URL: {{pr_url}}; shell: {{cmd}}; html: {{html}}';
    const result = interpolatePostApprovalTemplate(template, {
      pr_url: 'https://example.com/a?b=1&c=2',
      cmd: "rm -rf / && echo 'hi' $VAR",
      html: '<script>alert(1)</script>',
    });
    expect(result.text).toBe(
      "URL: https://example.com/a?b=1&c=2; shell: rm -rf / && echo 'hi' $VAR; html: <script>alert(1)</script>"
    );
  });

  test('identifier-shaped tokens only (no dotted paths, no helpers)', () => {
    // `{{a.b}}` is NOT a valid token — it stays literal.
    const result = interpolatePostApprovalTemplate('{{a.b}} {{a b}} {{1foo}}', {
      'a.b': 'should not substitute',
      'a b': 'should not substitute',
      '1foo': 'should not substitute',
    });
    // Every one of those templates failed to match the identifier pattern,
    // so they remain literal and nothing is reported missing.
    expect(result.text).toBe('{{a.b}} {{a b}} {{1foo}}');
    expect(result.missingKeys).toEqual([]);
  });

  test('internal whitespace around the identifier is allowed', () => {
    const result = interpolatePostApprovalTemplate('{{  task_id  }}', { task_id: 't-42' });
    expect(result.text).toBe('t-42');
  });

  test('empty template round-trips', () => {
    expect(interpolatePostApprovalTemplate('', { any: 1 })).toEqual({
      text: '',
      missingKeys: [],
    });
  });

  test('values are stringified via String(value) (numbers, booleans)', () => {
    const result = interpolatePostApprovalTemplate('{{n}}/{{b}}', { n: 42, b: true });
    expect(result.text).toBe('42/true');
  });
});
