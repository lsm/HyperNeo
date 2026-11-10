import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

it.each([
  ['file_changed', 'This file changed while loading. Reopen it to read the current version.'],
  ['owner_unavailable', 'The daemon that owns this file is not reachable.'],
  ['unsupported_type', 'This format has no preview yet.'],
  ['size_limit', 'This file is too large to preview here.'],
  ['safe_open_unavailable', 'This platform cannot safely open file references.'],
])('shows a clear %s refusal without falling back to a captured file', async (reason, message) => {
  request.mockResolvedValue({ accepted: false, reason });
  render(<ArtifactPreviewPanel />);
  act(() => openArtifactPreview({ kind: 'reference', source, reference: 'notes.md' }));
  await screen.findByText(message);
  expect(request).toHaveBeenCalledTimes(1);
  expect(artifactPreviewStack.value.at(-1)?.kind).toBe('reference');
});

it('clears the displayed content on disconnect and reads the current file on reconnect', async () => {
  const reply = (text: string) => ({
    accepted: true,
    kind: 'markdown',
    data: Buffer.from(text).toString('base64'),
    version: 'a'.repeat(64),
    byteLength: Buffer.byteLength(text),
    nextOffset: Buffer.byteLength(text),
    complete: true,
  });
  request.mockResolvedValue(reply('# Before disconnect'));
  render(<ArtifactPreviewPanel />);
  act(() => openArtifactPreview({ kind: 'reference', source, reference: 'notes.md' }));
  await screen.findByRole('heading', { name: 'Before disconnect' });
  act(() => {
    connectionState.value = 'disconnected';
  });
  await screen.findByText('The daemon that owns this file is not reachable.');
  expect(screen.queryByRole('heading', { name: 'Before disconnect' })).toBeNull();
  request.mockResolvedValue(reply('# After reconnect'));
  act(() => {
    connectionState.value = 'connected';
  });
  await screen.findByRole('heading', { name: 'After reconnect' });
  expect(request).toHaveBeenCalledTimes(2);
});

it('downloads a current video without replacing the playing preview', async () => {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(24, 0);
  bytes.write('ftypmp42', 4);
  bytes.write('mp42mp42', 16);
  request.mockResolvedValue({
    accepted: true,
    kind: 'video',
    data: bytes.toString('base64'),
    version: 'a'.repeat(64),
    byteLength: bytes.length,
    nextOffset: bytes.length,
    complete: true,
  });
  let nextUrl = 0;
  const createUrl = vi.fn(() => `blob:video-${++nextUrl}`);
  const revokeUrl = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    }
  );
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<ArtifactPreviewPanel />);
  act(() => openArtifactPreview({ kind: 'reference', source, reference: 'clip.mp4' }));
  await waitFor(() =>
    expect(document.querySelector('video')?.getAttribute('src')).toBe('blob:video-1')
  );
  const video = document.querySelector('video')!;
  video.currentTime = 5;
  fireEvent.click(screen.getByRole('button', { name: 'Download complete file' }));
  await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  expect(request).toHaveBeenCalledTimes(2);
  expect(document.querySelector('video')).toBe(video);
  expect(video.getAttribute('src')).toBe('blob:video-1');
  expect(video.currentTime).toBe(5);
  expect(pause).not.toHaveBeenCalled();
  expect(revokeUrl).not.toHaveBeenCalledWith('blob:video-1');
  expect(createUrl).toHaveBeenCalledTimes(2);
});
