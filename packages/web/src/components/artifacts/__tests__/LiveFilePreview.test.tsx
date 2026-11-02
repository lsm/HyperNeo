import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectionState } from '../../../lib/state.ts';
import {
  artifactPreviewStack,
  closeArtifactPreview,
  openArtifactPreview,
} from '../../../lib/artifact-preview-store.ts';
import MarkdownRenderer from '../../chat/MarkdownRenderer.tsx';
import { ArtifactPreviewPanel } from '../ArtifactPreviewPanel.tsx';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));
const source = { kind: 'publication' as const, id: 'public-reply', revisionId: 'visible-revision' };

beforeEach(() => {
  connectionState.value = 'connected';
  act(closeArtifactPreview);
});
afterEach(() => {
  act(closeArtifactPreview);
  cleanup();
  vi.clearAllMocks();
});

it('opens current Markdown from a visible path, reloads edits and reports deletion without promoting it', async () => {
  let text: string | null = '# Current A\n\n中文';
  request.mockImplementation(async (_method: string, { name, input }) => {
    if (name !== 'file.reference.read') return { accepted: false, reason: 'missing' };
    if (text === null) return { accepted: false, reason: 'missing' };
    const bytes = Buffer.from(text);
    const offset = input.offset ?? 0;
    const nextOffset = Math.min(bytes.length, offset + 9);
    return {
      accepted: true,
      kind: 'markdown',
      data: bytes.subarray(offset, nextOffset).toString('base64'),
      version: 'a'.repeat(64),
      byteLength: bytes.length,
      nextOffset,
      complete: nextOffset === bytes.length,
    };
  });
  render(
    <>
      <MarkdownRenderer
        content="Open `notes.md`."
        references={['notes.md']}
        onReference={(reference) => openArtifactPreview({ kind: 'reference', source, reference })}
      />
      <ArtifactPreviewPanel />
    </>
  );
  const tap = await screen.findByRole('link', { name: 'Open preview: notes.md' });
  fireEvent.click(tap);
  await screen.findByRole('heading', { name: 'Current A' });
  expect(screen.getByText('中文')).toBeTruthy();
  expect(artifactPreviewStack.value.at(-1)).toEqual({
    kind: 'reference',
    source,
    reference: 'notes.md',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  text = '# Current B';
  fireEvent.click(tap);
  await screen.findByRole('heading', { name: 'Current B' });
  expect(screen.queryByRole('heading', { name: 'Current A' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  text = null;
  fireEvent.click(tap);
  await screen.findByText('This file is no longer there.');
  expect(request.mock.calls.every(([, { name }]) => name === 'file.reference.read')).toBe(true);
});
