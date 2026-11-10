import { expect, test } from 'bun:test';
import vectors from './fixtures/file-path-boundaries.json' with { type: 'json' };
import {
  previewLinkedReferenceCandidates,
  previewLinkedReferenceSpans,
} from '../src/types/artifact-reference.ts';

test.each(vectors)('extracts the complete owner paths from $text', ({ text, paths }) => {
  expect(
    previewLinkedReferenceCandidates(text).flatMap((item) =>
      item.kind === 'local' ? [item.path] : []
    )
  ).toEqual(paths);
});

test.each(vectors)('marks the same literal path spans in $text', ({ text, paths }) => {
  expect(previewLinkedReferenceSpans(text).map((span) => span.reference)).toEqual(paths);
});

test('returns only literal local path spans outside fenced code and URLs', () => {
  const text =
    '报告：/Users/a/b.md。 Read `/Users/a/with space.md`.\n\n```text\n/Users/a/b.md\n```\n\nhttps://host/Users/a/b.md and [external /Users/a/b.md](https://example.com).';
  const spans = previewLinkedReferenceSpans(text);
  expect(
    spans.map(({ start, end, reference }) => ({ text: text.slice(start, end), reference }))
  ).toEqual([
    { text: '/Users/a/b.md', reference: '/Users/a/b.md' },
    { text: '/Users/a/with space.md', reference: '/Users/a/with space.md' },
  ]);
});

test('retains an encoded local file URL exactly', () => {
  const text = 'Open [the report](file:///Users/a/My%20report.md).';
  const [span] = previewLinkedReferenceSpans(text);
  expect(span && text.slice(span.start, span.end)).toBe('file:///Users/a/My%20report.md');
  expect(span?.reference).toBe('file:///Users/a/My%20report.md');
});
