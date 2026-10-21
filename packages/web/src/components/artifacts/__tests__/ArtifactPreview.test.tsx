import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../../lib/state.ts';
import { ArtifactPreview } from '../ArtifactPreview.tsx';
import MarkdownRenderer from '../../chat/MarkdownRenderer.tsx';

const { request, getHub } = vi.hoisted(() => {
  const request = vi.fn();
  return { request, getHub: vi.fn(async () => ({ request })) };
});
vi.mock('../../../lib/connection-manager.ts', () => ({ connectionManager: { getHub } }));

const markdown = '# Weekly report\n\nRead [the docs](https://example.com/docs).';
const bytes = new TextEncoder().encode(markdown);
const meta = (revision?: object, kind = 'markdown', byteLength = bytes.length) => ({
  accepted: true,
  metadata: {
    context: { kind: 'todo', id: 'todo-1' },
    artifact: {
      daemonId: 'd1',
      artifactId: 'a1',
      title: 'A very long synthetic weekly report title that the header shortens',
      kind,
      byteLength,
    },
    sha256: 'ab12cd34'.padEnd(64, '0'),
    createdAt: 1,
    sourcePath: '/synthetic/private/report.md',
    producer: { adapter: 'hyperneo', id: 's1' },
    ...(revision ? { revision } : {}),
  },
});
const chunk = {
  accepted: true,
  data: Buffer.from(bytes).toString('base64'),
  nextOffset: bytes.length,
  byteLength: bytes.length,
  sha256: 'ab12cd34'.padEnd(64, '0'),
  complete: true,
};

function reply(...replies: unknown[]) {
  request.mockImplementation(async () => replies.shift());
}

beforeEach(() => {
  connectionState.value = 'connected';
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ArtifactPreview', () => {
  it('shows the header facts and the rendered Markdown, then its source', async () => {
    reply(
      meta({ kind: 'commit', repository: 'r', commitSha: '0123456789abcdef', blobSha: 'b' }),
      chunk
    );
    render(<ArtifactPreview artifactId="a1" onBack={() => {}} />);
    expect(screen.getByText('Loading preview…')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly report' })).toBeTruthy()
    );
    const title = screen.getByText(/A very long synthetic/);
    expect(title.getAttribute('title')).toBe(
      'A very long synthetic weekly report title that the header shortens'
    );
    expect(screen.getByText(`Markdown · ${bytes.length} B · commit 0123456`)).toBeTruthy();
    expect(document.body.textContent).not.toContain('/synthetic/private');

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(document.querySelector('pre')?.textContent).toBe(markdown);
    expect(screen.queryByRole('heading', { name: 'Weekly report' })).toBeNull();
  });

  it('labels an uncommitted capture as a worktree snapshot with its hash', async () => {
    reply(meta({ kind: 'worktree' }), chunk);
    render(<ArtifactPreview artifactId="a1" onBack={() => {}} />);
    await waitFor(() =>
      expect(
        screen.getByText(`Markdown · ${bytes.length} B · worktree snapshot ab12cd34`)
      ).toBeTruthy()
    );
  });

  it('opens an external link only after the human confirms it', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    reply(meta(), chunk);
    render(<ArtifactPreview artifactId="a1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('the docs')).toBeTruthy());
    fireEvent.click(screen.getByText('the docs'));
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText('https://example.com/docs')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open link' }));
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
  });

  it.each([
    [
      'unavailable daemon',
      () => request.mockRejectedValue(new Error('closed')),
      'The daemon that owns this file is not reachable.',
    ],
    [
      'an old daemon',
      () =>
        request.mockRejectedValue(
          Object.assign(new Error('Unknown operation'), { code: 'METHOD_NOT_FOUND' })
        ),
      'Preview needs an updated daemon.',
    ],
    [
      'revoked access',
      () => reply({ accepted: false, reason: 'unavailable' }),
      'This file is no longer available to you.',
    ],
    ['unsupported format', () => reply(meta(undefined, 'html')), 'This format has no preview yet.'],
    [
      'preview limit',
      () => reply(meta(undefined, 'markdown', 3 * 1024 * 1024)),
      'This file is larger than the 2 MB preview limit.',
    ],
  ])('shows %s as its own state', async (_name, arrange, message) => {
    arrange();
    render(<ArtifactPreview artifactId="a1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
  });

  it('drops the loaded text when the connection goes away and rereads on reconnect', async () => {
    reply(meta(), chunk, meta(), chunk);
    render(<ArtifactPreview artifactId="a1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('the docs')).toBeTruthy());
    act(() => {
      connectionState.value = 'disconnected';
    });
    expect(screen.queryByText('the docs')).toBeNull();
    expect(screen.getByText('The daemon that owns this file is not reachable.')).toBeTruthy();
    act(() => {
      connectionState.value = 'connecting';
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getByText('The daemon that owns this file is not reachable.')).toBeTruthy();
    expect(screen.queryByText('Loading preview…')).toBeNull();
    act(() => {
      connectionState.value = 'connected';
    });
    await waitFor(() => expect(screen.getByText('the docs')).toBeTruthy());
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('starts the connection on first open and reads once it is connected', async () => {
    connectionState.value = 'connecting';
    reply(meta(), chunk);
    render(<ArtifactPreview artifactId="a1" onBack={() => {}} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(request).not.toHaveBeenCalled();
    expect(getHub).toHaveBeenCalled();
    act(() => {
      connectionState.value = 'connected';
    });
    await waitFor(() => expect(screen.getByText('the docs')).toBeTruthy());
  });

  it('goes back when Back is pressed', async () => {
    reply(meta(), chunk);
    const onBack = vi.fn();
    render(<ArtifactPreview artifactId="a1" onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('forgets the rendered Markdown when the connection goes away', async () => {
    reply(meta(), chunk);
    render(<ArtifactPreview artifactId="a1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('the docs')).toBeTruthy());
    act(() => {
      connectionState.value = 'disconnected';
    });
    cleanup();
    const again = render(<MarkdownRenderer content={markdown} artifactLinks />);
    expect(again.container.querySelector('.prose')?.childElementCount).toBe(0);
  });
});
