import { describe, expect, test } from 'bun:test';
import {
  previewLinkedReferenceCandidates,
  previewReferenceCandidates,
} from '../src/types/artifact-reference.ts';

describe('automatically linked file references', () => {
  test('relative mentions stay available to explicit source-bound reads but do not become automatic links', () => {
    const text = '`CLAUDE.md` `docs/guide.md` [Relative](./report.md) file:relative.md';
    expect(previewReferenceCandidates(text).length).toBeGreaterThan(0);
    expect(previewLinkedReferenceCandidates(text)).toEqual([]);
  });
  test('preserves original absolute, home-relative and pinned Git references', () => {
    const pinned = `https://github.com/example/project/blob/${'a'.repeat(40)}/CLAUDE.md`;
    const refs = [
      '/owner/report.md',
      '~/reports/home.md',
      'file:///owner/current%20report.md',
      pinned,
    ];
    expect(
      previewLinkedReferenceCandidates(refs.map((ref) => `[Open](${ref})`).join('\n')).map(
        (ref) => ref.reference
      )
    ).toEqual(refs);
  });
  test('links local files only in formats the daemon previews, and leaves web links alone', () => {
    const pinned = `https://github.com/example/project/blob/${'a'.repeat(40)}/scripts/run.sh`;
    const text = [
      '[Run](/owner/run.sh)',
      '[Doc](/owner/doc.pdf)',
      '[Notes](file:///owner/notes.md)',
      `[Pinned](${pinned})`,
      '[PR](https://github.com/example/project/pull/7)',
    ].join('\n');
    expect(previewLinkedReferenceCandidates(text).map((ref) => ref.reference)).toEqual([
      'file:///owner/notes.md',
      pinned,
      'https://github.com/example/project/pull/7',
    ]);
  });
});
