import { describe, expect, test } from 'bun:test';
import {
  ARTIFACT_SHAPES,
  deriveArtifactKey,
  isArtifactShape,
  normalizeLinkData,
  resolveLegacyShape,
  validateArtifactShape,
} from '../src/artifact-shapes.ts';

describe('artifact-shapes: vocabulary', () => {
  test('ARTIFACT_SHAPES is the closed set', () => {
    expect(ARTIFACT_SHAPES).toEqual(['link', 'commit_set', 'check', 'metric', 'decision', 'note']);
  });

  test('isArtifactShape accepts only members of the set', () => {
    expect(isArtifactShape('link')).toBe(true);
    expect(isArtifactShape('note')).toBe(true);
    expect(isArtifactShape('pr')).toBe(false);
    expect(isArtifactShape('result')).toBe(false);
    expect(isArtifactShape('')).toBe(false);
    expect(isArtifactShape(undefined)).toBe(false);
  });
});

describe('artifact-shapes: deriveArtifactKey (identity rules)', () => {
  test('note is always a single rolling-status key', () => {
    expect(deriveArtifactKey('note', { text: 'a' })).toBe('current');
    expect(deriveArtifactKey('note', { text: 'b', kind: 'status' })).toBe('current');
  });

  test('link is keyed by kind (one per kind)', () => {
    expect(deriveArtifactKey('link', { url: 'u', kind: 'pr' })).toBe('pr');
    expect(deriveArtifactKey('link', { url: 'u', kind: 'issue' })).toBe('issue');
    expect(deriveArtifactKey('link', { url: 'u' })).toBe('default');
  });

  test('check and metric are keyed by name', () => {
    expect(deriveArtifactKey('check', { name: 'ci', status: 'pass' })).toBe('ci');
    expect(deriveArtifactKey('metric', { name: 'latency', value: 1 })).toBe('latency');
  });

  test('commit_set is keyed by branch', () => {
    expect(deriveArtifactKey('commit_set', { branch: 'main' })).toBe('main');
    expect(deriveArtifactKey('commit_set', {})).toBe('default');
  });

  test('decision defaults to single terminal, but honors explicit key for rounds', () => {
    expect(deriveArtifactKey('decision', { recommendation: 'approve', kind: 'review' })).toBe(
      'review'
    );
    expect(deriveArtifactKey('decision', { recommendation: 'approve' })).toBe('current');
    expect(deriveArtifactKey('decision', { recommendation: 'request_changes' }, 'round-3')).toBe(
      'round-3'
    );
  });

  test('non-decision shapes ignore explicitKey (note stays a single rolling row)', () => {
    expect(deriveArtifactKey('note', { text: 'a' }, 'round-5')).toBe('current');
    expect(deriveArtifactKey('link', { url: 'u', kind: 'pr' }, 'override')).toBe('pr');
    expect(deriveArtifactKey('check', { name: 'ci', status: 'pass' }, 'override')).toBe('ci');
  });
});

describe('artifact-shapes: validateArtifactShape', () => {
  test('link requires data.url', () => {
    expect(validateArtifactShape('link', { url: 'https://x' })).toEqual({ ok: true });
    const bad = validateArtifactShape('link', { title: 'no url' });
    expect(bad.ok).toBe(false);
  });

  test('check requires name + status', () => {
    expect(validateArtifactShape('check', { name: 'ci', status: 'pass' })).toEqual({ ok: true });
    expect(validateArtifactShape('check', { name: 'ci' }).ok).toBe(false);
    expect(validateArtifactShape('check', { status: 'pass' }).ok).toBe(false);
  });

  test('metric requires name + a scalar (number|string) value', () => {
    expect(validateArtifactShape('metric', { name: 'n', value: 5 })).toEqual({ ok: true });
    expect(validateArtifactShape('metric', { name: 'n', value: '5ms' })).toEqual({ ok: true });
    expect(validateArtifactShape('metric', { name: 'n' }).ok).toBe(false);
    expect(validateArtifactShape('metric', { value: 5 }).ok).toBe(false);
    expect(validateArtifactShape('metric', { name: 'n', value: [1, 2] }).ok).toBe(false);
    expect(validateArtifactShape('metric', { name: 'n', value: { a: 1 } }).ok).toBe(false);
    expect(validateArtifactShape('metric', { name: 'n', value: true }).ok).toBe(false);
  });

  test('decision requires recommendation', () => {
    expect(validateArtifactShape('decision', { recommendation: 'approve' })).toEqual({ ok: true });
    expect(validateArtifactShape('decision', { summary: 'x' }).ok).toBe(false);
  });

  test('note accepts text, summary, or a bare timestamp', () => {
    expect(validateArtifactShape('note', { text: 'x' })).toEqual({ ok: true });
    expect(validateArtifactShape('note', { summary: 'x' })).toEqual({ ok: true });
    expect(validateArtifactShape('note', { ts: '2026-01-01T00:00:00Z' })).toEqual({ ok: true });
    expect(validateArtifactShape('note', {}).ok).toBe(false);
  });

  test('commit_set has no required field', () => {
    expect(validateArtifactShape('commit_set', {})).toEqual({ ok: true });
  });
});

describe('artifact-shapes: resolveLegacyShape (data-aware router)', () => {
  test('pr → link, progress → note, review → decision', () => {
    expect(resolveLegacyShape('pr', {})).toBe('link');
    expect(resolveLegacyShape('progress', {})).toBe('note');
    expect(resolveLegacyShape('review', {})).toBe('decision');
  });

  test('result with a URL but no summary → link', () => {
    expect(resolveLegacyShape('result', { pr_url: 'u' })).toBe('link');
    expect(resolveLegacyShape('result', { url: 'u' })).toBe('link');
    expect(resolveLegacyShape('result', { review_url: 'u' })).toBe('link');
  });

  test('result with a summary → decision (summary preserved even alongside a URL)', () => {
    expect(resolveLegacyShape('result', { summary: 'shipped' })).toBe('decision');
    expect(resolveLegacyShape('result', { summary: 'QA passed', pr_url: 'u' })).toBe('decision');
    expect(resolveLegacyShape('result', {})).toBe('decision');
  });

  test('unknown type → undefined', () => {
    expect(resolveLegacyShape('banana', {})).toBeUndefined();
    expect(resolveLegacyShape('code-pr-gate', {})).toBeUndefined();
  });
});

describe('artifact-shapes: normalizeLinkData', () => {
  test('copies pr_url onto data.url when missing', () => {
    expect(normalizeLinkData({ pr_url: 'https://x' })).toEqual({
      pr_url: 'https://x',
      url: 'https://x',
    });
  });

  test('copies prUrl onto data.url when missing', () => {
    expect(normalizeLinkData({ prUrl: 'https://x' })).toEqual({
      prUrl: 'https://x',
      url: 'https://x',
    });
  });

  test('leaves data.url untouched when already set', () => {
    expect(normalizeLinkData({ url: 'https://x', pr_url: 'https://y' })).toEqual({
      url: 'https://x',
      pr_url: 'https://y',
    });
  });

  test('returns data unchanged when no URL field is present', () => {
    expect(normalizeLinkData({ title: 't' })).toEqual({ title: 't' });
  });
});
