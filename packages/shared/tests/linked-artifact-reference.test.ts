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
});
