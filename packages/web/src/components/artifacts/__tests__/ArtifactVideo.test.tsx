import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactVideo } from '../ArtifactVideo.tsx';

const createUrl = vi.fn();
const revokeUrl = vi.fn();
beforeEach(() => {
  let next = 0;
  createUrl.mockImplementation(() => `blob:video-${++next}`);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    }
  );
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ArtifactVideo', () => {
  it('provides native inline controls and releases playback and its URL on close', async () => {
    const { unmount } = render(<ArtifactVideo blob={new Blob(['movie'])} title="Clip" />);
    const video = document.querySelector('video')!;
    await waitFor(() => expect(video.getAttribute('src')).toBe('blob:video-1'));
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.hasAttribute('autoplay')).toBe(false);
    unmount();
    expect(video.pause).toHaveBeenCalled();
    expect(video.load).toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalledWith('blob:video-1');
  });
  it('releases the old source when the video changes', async () => {
    const { rerender } = render(<ArtifactVideo blob={new Blob(['first'])} title="First" />);
    await waitFor(() => expect(createUrl).toHaveBeenCalledTimes(1));
    rerender(<ArtifactVideo blob={new Blob(['second'])} title="Second" />);
    await waitFor(() =>
      expect(document.querySelector('video')?.getAttribute('src')).toBe('blob:video-2')
    );
    expect(revokeUrl).toHaveBeenCalledWith('blob:video-1');
  });
  it('names H.264/AAC MP4 when the browser rejects playback', async () => {
    render(<ArtifactVideo blob={new Blob(['unsupported'])} title="Clip" />);
    await waitFor(() => expect(createUrl).toHaveBeenCalledTimes(1));
    fireEvent.error(document.querySelector('video')!);
    expect(screen.getByRole('status').textContent).toContain('H.264/AAC MP4');
  });
});
