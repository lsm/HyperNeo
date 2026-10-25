import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../../lib/state.ts';
import { ArtifactPreview } from '../ArtifactPreview.tsx';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));
const source = '<h1>Static report</h1><script>window.hostile = 1</script>';
const metadata = {
  context: { kind: 'todo', id: 'todo' },
  artifact: {
    daemonId: 'd',
    artifactId: 'html',
    title: 'Static HTML report',
    kind: 'html',
    byteLength: source.length,
  },
  sha256: 'a'.repeat(64),
  createdAt: 1,
  sourcePath: 'report.html',
  producer: { adapter: 'hyperneo', id: 'worker' },
};
const prepared = {
  accepted: true,
  sha256: metadata.sha256,
  document: '<!doctype html><html><body><h1>Static report</h1></body></html>',
  scriptsRemoved: true,
  links: [{ text: 'Docs', href: 'https://example.com/docs' }],
};
beforeEach(() => {
  connectionState.value = 'connected';
  request.mockImplementation(async (_method, call) => {
    if (call.name === 'artifact.file.get') return { accepted: true, metadata };
    if (call.name === 'artifact.file.html') return prepared;
    return {
      accepted: true,
      data: btoa(source),
      nextOffset: source.length,
      complete: true,
      sha256: metadata.sha256,
      byteLength: source.length,
    };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('locked-down HTML artifact viewer', () => {
  it('opens only the prepared HTML in an opaque sandbox and shows the scripts-disabled state', async () => {
    const { container } = render(<ArtifactPreview artifactId="html" onBack={() => {}} />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toBe(prepared.document);
    expect(screen.getByText('Scripts disabled')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(request.mock.calls.some(([, call]) => call.name === 'artifact.file.read')).toBe(false);
  });

  it('shows a result-only document with metadata and no source or download transfer', async () => {
    const { container } = render(
      <ArtifactPreview artifactId="html" onBack={() => {}} presentation="tabbed" />
    );
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toBe(prepared.document);
    expect(screen.getByText(`HTML · ${source.length} B · snapshot aaaaaaaa`)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: metadata.artifact.title })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Source', exact: true })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download complete file' })).toBeNull();
    expect(request.mock.calls.map(([, call]) => call.name)).toEqual([
      'artifact.file.get',
      'artifact.file.html',
    ]);
    act(() => {
      connectionState.value = 'disconnected';
    });
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText('The daemon that owns this file is not reachable.')).toBeTruthy();
  });

  it('keeps a sanitizer refusal as a status without reading original source in result mode', async () => {
    request.mockImplementation(async (_method, call) =>
      call.name === 'artifact.file.get'
        ? { accepted: true, metadata }
        : { accepted: false, reason: 'size_limit' }
    );
    const { container } = render(
      <ArtifactPreview artifactId="html" onBack={() => {}} presentation="result" />
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: metadata.artifact.title })).toBeTruthy()
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').textContent).toBe('This HTML document cannot be previewed.');
    expect(container.querySelector('iframe, pre')).toBeNull();
    expect(screen.getByRole('heading', { name: metadata.artifact.title })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Source', exact: true })).toBeNull();
  });

  it('reads original HTML only on Source and renders it as escaped text', async () => {
    const { container } = render(<ArtifactPreview artifactId="html" onBack={() => {}} />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    await waitFor(() => expect(container.querySelector('pre')?.textContent).toBe(source));
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('requires explicit host confirmation for an HTML document link', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<ArtifactPreview artifactId="html" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Docs' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText('https://example.com/docs')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open link' }));
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('removes the iframe and source buffers immediately on disconnect', async () => {
    const { container } = render(<ArtifactPreview artifactId="html" onBack={() => {}} />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    act(() => {
      connectionState.value = 'disconnected';
    });
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.getByText('The daemon that owns this file is not reachable.')).toBeTruthy();
  });
});
