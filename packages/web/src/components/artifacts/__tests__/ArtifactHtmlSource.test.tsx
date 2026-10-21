import type { ArtifactFileMetadata } from '@hyperneo/shared/types/artifact-file';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactHtmlSource } from '../ArtifactHtmlSource.tsx';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));
const metadata = {
  artifact: { artifactId: 'a', byteLength: 18 },
  sha256: 'a'.repeat(64),
} as ArtifactFileMetadata;
beforeEach(() => {
  request.mockReset();
});
afterEach(cleanup);

describe('ArtifactHtmlSource', () => {
  it('keeps original scripts as text without constructing active DOM', async () => {
    const text = '<script>alert(1)</script>';
    request.mockResolvedValue({
      accepted: true,
      data: btoa(text),
      complete: true,
      nextOffset: text.length,
    });
    const { container } = render(
      <ArtifactHtmlSource metadata={metadata} onUnavailable={() => {}} />
    );
    await waitFor(() => expect(container.querySelector('pre')?.textContent).toBe(text));
    expect(container.querySelector('script,iframe')).toBeNull();
  });
  it('discards a pending read when the source view unmounts', async () => {
    let finish: (value: unknown) => void = () => {};
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const onUnavailable = vi.fn();
    const view = render(<ArtifactHtmlSource metadata={metadata} onUnavailable={onUnavailable} />);
    await waitFor(() => expect(request).toHaveBeenCalled());
    view.unmount();
    finish({ accepted: false, reason: 'unavailable' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(document.querySelector('pre')).toBeNull();
  });
  it('withholds the whole cached preview on a read refusal', async () => {
    request.mockResolvedValue({ accepted: false, reason: 'unavailable' });
    const onUnavailable = vi.fn();
    render(<ArtifactHtmlSource metadata={metadata} onUnavailable={onUnavailable} />);
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledWith({ state: 'revoked' }));
    expect(screen.queryByText('<script>')).toBeNull();
  });
});
