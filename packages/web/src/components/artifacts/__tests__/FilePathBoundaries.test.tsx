import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, expect, it } from 'vitest';
import vectors from '../../../../../shared/tests/fixtures/file-path-boundaries.json';
import { FileReferenceCards } from '../FileReferenceCards.tsx';
import { artifactPreviewStack, closeArtifactPreview } from '../../../lib/artifact-preview-store.ts';

afterEach(() => {
  cleanup();
  closeArtifactPreview();
});
it.each(vectors)('renders exactly the readable paths in $text', ({ text, paths }) => {
  render(
    <FileReferenceCards
      text={text}
      source={{ kind: 'publication', id: 'synthetic' }}
      ownerHome={null}
    />
  );
  const cards = screen.queryAllByRole('button');
  expect(cards.map((card) => card.getAttribute('title'))).toEqual(paths);
  for (const [index, path] of paths.entries()) {
    fireEvent.click(cards[index]);
    expect(artifactPreviewStack.value.at(-1)).toMatchObject({
      kind: 'reference',
      reference: path,
      source: { kind: 'publication', id: 'synthetic' },
    });
  }
});
