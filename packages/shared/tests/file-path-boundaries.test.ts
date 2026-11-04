import { expect, test } from 'bun:test';
import vectors from './fixtures/file-path-boundaries.json' with { type: 'json' };
import { previewLinkedReferenceCandidates } from '../src/types/artifact-reference.ts';

test.each(vectors)('extracts the complete owner paths from $text', ({ text, paths }) => {
  expect(
    previewLinkedReferenceCandidates(text).flatMap((item) =>
      item.kind === 'local' ? [item.path] : []
    )
  ).toEqual(paths);
});
