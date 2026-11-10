import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../../lib/state.ts';
import {
  artifactPreviewWorkspace,
  artifactPreviewStack,
  closeArtifactPreview,
  openArtifactPreview,
  pushArtifactPreview,
  takeArtifactPreviewOpener,
} from '../../../lib/artifact-preview-store.ts';
import { ArtifactPreviewPanel } from '../ArtifactPreviewPanel.tsx';
import { ArtifactCards } from '../ArtifactCards.tsx';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));
let width = 700;
let desktop = true;
const observers = new Set<ResizeObserverCallback>();
const title = (id: string) => `Report ${id.toUpperCase()}`;
const text = (id: string) => `# Document ${id}\n\nOriginal content ${id}`;
const ref = (id: string) => ({
  daemonId: 'd',
  artifactId: id,
  title: title(id),
  kind: 'markdown' as const,
  byteLength: Buffer.byteLength(text(id)),
});
const open = async (id: string) => {
  act(() => openArtifactPreview({ kind: 'artifact', artifactId: id }, title(id)));
  await screen.findByRole('heading', { name: `Document ${id}` });
};

beforeEach(() => {
  closeArtifactPreview();
  takeArtifactPreviewOpener();
  width = 700;
  desktop = true;
  connectionState.value = 'connected';
  vi.spyOn(history, 'back').mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
    matches: desktop,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() {
        observers.add(this.callback);
      }
      unobserve() {}
      disconnect() {
        observers.delete(this.callback);
      }
    }
  );
  request.mockImplementation(async (_method, { name, input }) => {
    const id = input.artifactId;
    if (name === 'artifact.file.get')
      return {
        accepted: true,
        metadata: {
          artifact: ref(id),
          context: { kind: 'todo', id: 'todo' },
          sha256: 'f'.repeat(64),
          createdAt: 1,
          sourcePath: `${id}.md`,
          producer: { adapter: 'hyperneo', id: 'worker' },
        },
      };
    return {
      accepted: true,
      data: Buffer.from(text(id)).toString('base64'),
      nextOffset: ref(id).byteLength,
      byteLength: ref(id).byteLength,
      sha256: 'f'.repeat(64),
      complete: true,
    };
  });
});
afterEach(() => {
  cleanup();
  closeArtifactPreview();
  takeArtifactPreviewOpener();
  observers.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('desktop preview file tabs', () => {
  it('shows an unavailable handoff instead of dropping it when the card source is missing', () => {
    const handoff = {
      type: 'handoff' as const,
      daemonId: 'd',
      artifactId: 'a'.repeat(64),
      sha256: 'a'.repeat(64),
      sessionId: 'worker',
      name: 'report.md',
      byteLength: 1,
    };
    render(<ArtifactCards artifacts={[handoff]} />);
    expect(
      screen.getByRole('button', { name: 'Open preview: report.md' }).hasAttribute('disabled')
    ).toBe(true);
    expect(
      screen.getByText('This reference points outside what the preview may open.')
    ).toBeTruthy();
  });

  it('reports an unavailable owner for a publication handoff', async () => {
    const handoff = {
      type: 'handoff' as const,
      daemonId: 'd',
      artifactId: 'a'.repeat(64),
      sha256: 'a'.repeat(64),
      sessionId: 'worker',
      name: 'remote.html',
      byteLength: 1,
    };
    request.mockResolvedValue({ accepted: false, reason: 'owner_unavailable' });
    render(
      <>
        <ArtifactCards artifacts={[handoff]} source={{ kind: 'publication', id: 'publication' }} />
        <ArtifactPreviewPanel fileTabs />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open preview: remote.html' }));
    expect(
      await screen.findByText('The daemon that owns this file is not reachable.')
    ).toBeTruthy();
    expect(request).toHaveBeenCalledWith(
      'operation.invoke',
      expect.objectContaining({
        name: 'file.handoff.read',
        input: expect.objectContaining({ source: { kind: 'publication', id: 'publication' } }),
      })
    );
  });
  it('opens a worker handoff from its question with source-bound reads', async () => {
    const handoff = {
      type: 'handoff' as const,
      daemonId: '10000000-0000-4000-8000-000000000001',
      artifactId: 'a'.repeat(64),
      sha256: 'a'.repeat(64),
      sessionId: 'synthetic-worker',
      name: 'worker-report.md',
      byteLength: 22,
    };
    const text = '# Handoff report\nReady';
    request.mockImplementation(async (_method, { name }) => {
      if (name !== 'file.handoff.read') throw new Error(`unexpected operation: ${name}`);
      return {
        accepted: true,
        kind: 'markdown',
        data: Buffer.from(text).toString('base64'),
        version: 'b'.repeat(64),
        byteLength: Buffer.byteLength(text),
        nextOffset: Buffer.byteLength(text),
        complete: true,
      };
    });
    render(
      <>
        <ArtifactCards artifacts={[handoff]} source={{ kind: 'question', id: 'question' }} />
        <ArtifactPreviewPanel fileTabs />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open preview: worker-report.md' }));
    await screen.findByRole('heading', { name: 'Handoff report' });
    expect(request).toHaveBeenCalledWith(
      'operation.invoke',
      expect.objectContaining({
        name: 'file.handoff.read',
        input: expect.objectContaining({
          source: { kind: 'question', id: 'question' },
          reference: handoff,
        }),
      })
    );
    expect(artifactPreviewStack.value.at(-1)).toMatchObject({
      kind: 'reference',
      reference: 'worker-report.md',
      handoff,
    });
  });
  it('opens real cards into reusable tabs with distinct accessible panel IDs', async () => {
    render(
      <>
        <ArtifactCards artifacts={[ref('a'), ref('b')]} />
        <ArtifactPreviewPanel fileTabs />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open preview: Report A' }));
    await screen.findByRole('heading', { name: 'Document a' });
    fireEvent.click(screen.getByRole('button', { name: 'Open preview: Report B' }));
    await screen.findByRole('heading', { name: 'Document b' });
    expect(screen.getAllByRole('tab').length).toBe(2);
    const b = screen.getByRole('tab', { name: 'Report B' });
    expect(screen.getByRole('tabpanel').id).toBe(b.getAttribute('aria-controls'));
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBe(b.id);
    expect(screen.getAllByText('Report B').length).toBe(1);
    expect(screen.queryByRole('button', { name: 'Back', exact: true })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Source', exact: true })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preview', exact: true })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download complete file' })).toBeNull();
    expect(
      within(screen.getByRole('tabpanel')).getByText(
        `Markdown · ${ref('b').byteLength} B · snapshot ffffffff`
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open preview: Report A' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Report A' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    );
    expect(screen.getAllByRole('tab').length).toBe(2);
  });

  it('retains rendered content and scroll position across file switches without reloading it', async () => {
    render(<ArtifactPreviewPanel fileTabs />);
    await open('a');
    const source = within(screen.getByRole('tabpanel')).getByRole('heading', {
      name: 'Document a',
    });
    const scroller = screen.getByRole('tabpanel').querySelector('.overflow-auto')!;
    scroller.scrollTop = 73;
    await open('b');
    fireEvent.click(screen.getByRole('tab', { name: 'Report A' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('tabpanel')).getByRole('heading', { name: 'Document a' })
      ).toBe(source)
    );
    expect(scroller.scrollTop).toBe(73);
    expect(
      request.mock.calls.filter(
        ([, params]) => params.name === 'artifact.file.get' && params.input.artifactId === 'a'
      ).length
    ).toBe(1);
  });

  it('keeps keyboard focus in the strip and closes background/selected tabs independently', async () => {
    render(<ArtifactPreviewPanel fileTabs />);
    await open('a');
    await open('b');
    await open('c');
    const c = screen.getByRole('tab', { name: 'Report C' });
    c.focus();
    fireEvent.keyDown(c, { key: 'ArrowLeft' });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Report B' }))
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close Report C' }));
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Report B' }));
    expect(screen.getByRole('tab', { name: 'Report B' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close Report B' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Report A' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close Report A' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(artifactPreviewWorkspace.state.value).toEqual({
      open: false,
      files: [],
      selectedId: null,
    });
  });

  it('shrinks first, then overflows with the selected file always visible', async () => {
    width = 480;
    render(<ArtifactPreviewPanel fileTabs />);
    await open('a');
    await open('b');
    await open('c');
    expect(screen.queryByRole('button', { name: /Other tabs/ })).toBeNull();
    const slot = screen.getByRole('tab', { name: 'Report C' }).parentElement!;
    expect(Number.parseFloat(slot.style.width)).toBeLessThan(176);
    expect(Number.parseFloat(slot.style.width)).toBeGreaterThanOrEqual(88);
    await open('d');
    await open('e');
    await open('f');
    width = 350;
    act(() => {
      for (const callback of observers) callback([], {} as ResizeObserver);
    });
    expect(screen.getByRole('tab', { name: 'Report F' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Other tabs (3)' }));
    const item = await screen.findByRole('menuitem', { name: 'Report D' });
    fireEvent.click(item);
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Report D' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    );
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Report D' }));
  });

  it('consumes menu Escape before preview Escape', async () => {
    width = 250;
    render(<ArtifactPreviewPanel fileTabs />);
    await open('a');
    await open('b');
    await open('c');
    const more = screen.getByRole('button', { name: 'Other tabs (1)' });
    fireEvent.click(more);
    const item = await screen.findByRole('menuitem');
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(more, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  const liveChunk = (id: string, body = text(id)) => ({
    accepted: true,
    kind: 'markdown',
    version: 'a'.repeat(64),
    data: Buffer.from(body).toString('base64'),
    byteLength: Buffer.byteLength(body),
    nextOffset: Buffer.byteLength(body),
    complete: true,
  });
  const liveTarget = (id: string) => ({
    kind: 'reference' as const,
    source: { kind: 'publication' as const, id: 'p' },
    reference: `${id}.md`,
  });

  it('keeps a live reference in its tab and closes back to the mounted legacy file', async () => {
    render(
      <>
        <button>Reference source</button>
        <ArtifactPreviewPanel fileTabs />
      </>
    );
    const source = screen.getByRole('button', { name: 'Reference source' });
    source.focus();
    await open('a');
    const heading = screen.getByRole('heading', { name: 'Document a' });
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) =>
      params.name === 'file.reference.read' ? liveChunk('b') : original(method, params)
    );
    act(() => pushArtifactPreview(liveTarget('b')));
    await screen.findByRole('heading', { name: 'Document b' });
    expect(artifactPreviewStack.value.at(-1)).toEqual(liveTarget('b'));
    await screen.findByRole('tab', { name: 'b.md' });
    expect(screen.queryByRole('button', { name: 'Back', exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close b.md' }));
    expect(screen.getByRole('heading', { name: 'Document a' })).toBe(heading);
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    await waitFor(() => expect(document.activeElement).toBe(source));
  });

  it('keeps legacy and live tabs separate and rereads the same path after a new tap', async () => {
    render(<ArtifactPreviewPanel fileTabs />);
    await open('a');
    const heading = screen.getByRole('heading', { name: 'Document a' });
    const original = request.getMockImplementation()!;
    let body = text('a');
    request.mockImplementation(async (method, params) =>
      params.name === 'file.reference.read' ? liveChunk('a', body) : original(method, params)
    );
    act(() => pushArtifactPreview(liveTarget('a')));
    await screen.findByRole('tab', { name: 'a.md' });
    await screen.findByRole('heading', { name: 'Document a' });
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Document a' })).not.toBe(heading);
    body = '# Updated a';
    act(() => openArtifactPreview(liveTarget('a')));
    await screen.findByRole('heading', { name: 'Updated a' });
    expect(
      request.mock.calls.filter(([, call]) => call.name === 'file.reference.read')
    ).toHaveLength(2);
    expect(
      request.mock.calls.filter(([, call]) => call.name === 'artifact.reference.resolve')
    ).toHaveLength(0);
    expect(request.mock.calls.filter(([, call]) => call.name === 'artifact.file.get')).toHaveLength(
      1
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Report A' }));
    expect(screen.getByRole('heading', { name: 'Document a' })).toBe(heading);
    body = '# Updated again';
    fireEvent.click(screen.getByRole('tab', { name: 'a.md' }));
    await screen.findByRole('heading', { name: 'Updated again' });
  });

  it.each([false, true])('discards equal-key stale loads with suspended=%s', async (suspended) => {
    const pending: ((value: unknown) => void)[] = [];
    request.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const view = render(<ArtifactPreviewPanel fileTabs />);
    act(() => openArtifactPreview(liveTarget('a')));
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => openArtifactPreview(liveTarget('a')));
    await waitFor(() => expect(pending).toHaveLength(2));
    if (suspended) view.rerender(<ArtifactPreviewPanel fileTabs suspended />);
    await act(async () => {
      pending[0](liveChunk('a', '# Old result'));
      if (suspended) pending[1](liveChunk('a', '# Old result'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole('heading', { name: 'Old result' })).toBeNull();
    if (suspended) {
      view.rerender(<ArtifactPreviewPanel fileTabs />);
      await waitFor(() => expect(pending).toHaveLength(3));
      act(() => pending[2](liveChunk('a')));
      await screen.findByRole('heading', { name: 'Document a' });
    } else {
      act(() => pending[1](liveChunk('a')));
      await screen.findByRole('heading', { name: 'Document a' });
    }
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(artifactPreviewStack.value.at(-1)).toEqual(liveTarget('a'));
  });

  it('does not read suspended live references and loads only the selected one on resume', async () => {
    const view = render(<ArtifactPreviewPanel fileTabs suspended />);
    request.mockResolvedValue(liveChunk('b'));
    act(() => openArtifactPreview(liveTarget('a')));
    act(() => openArtifactPreview(liveTarget('b')));
    expect(request).not.toHaveBeenCalled();
    view.rerender(<ArtifactPreviewPanel fileTabs />);
    await screen.findByRole('heading', { name: 'Document b' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].input.reference).toBe('b.md');
    expect(artifactPreviewWorkspace.state.value.files).toHaveLength(2);
  });

  it('ignores old or closed live requests and reads a reopened path again', async () => {
    render(<ArtifactPreviewPanel fileTabs />);
    const pending = new Map<string, (value: unknown) => void>();
    request.mockImplementation(
      (_method, params) => new Promise((resolve) => pending.set(params.input.reference, resolve))
    );
    act(() => openArtifactPreview(liveTarget('a')));
    await waitFor(() => expect(pending.has('a.md')).toBe(true));
    act(() => openArtifactPreview(liveTarget('b')));
    await waitFor(() => expect(pending.has('b.md')).toBe(true));
    act(() => pending.get('b.md')!(liveChunk('b')));
    await screen.findByRole('heading', { name: 'Document b' });
    await act(async () => {
      pending.get('a.md')!(liveChunk('a'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole('heading', { name: 'Document a' })).toBeNull();
    expect(artifactPreviewStack.value.at(-1)).toEqual(liveTarget('b'));
    act(() => openArtifactPreview(liveTarget('c')));
    await waitFor(() => expect(pending.has('c.md')).toBe(true));
    act(closeArtifactPreview);
    await act(async () => {
      pending.get('c.md')!(liveChunk('c'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => openArtifactPreview(liveTarget('c')));
    await waitFor(() =>
      expect(request.mock.calls.filter(([, call]) => call.input.reference === 'c.md')).toHaveLength(
        2
      )
    );
    act(() => pending.get('c.md')!(liveChunk('c')));
    await screen.findByRole('heading', { name: 'Document c' });
  });

  it('retains the SHA-bound changed-file Back flow for PR navigation', async () => {
    render(<ArtifactPreviewPanel fileTabs />);
    await open('a');
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) =>
      params.name === 'artifact.reference.resolve'
        ? { accepted: true, artifact: { artifactId: 'b' } }
        : original(method, params)
    );
    act(() =>
      pushArtifactPreview({
        kind: 'reference',
        source: { kind: 'publication', id: 'p' },
        reference: 'https://github.com/example/demo/pull/1',
        file: { path: 'b.md', headSha: 'a'.repeat(40) },
      })
    );
    await screen.findByRole('heading', { name: 'Document b' });
    expect(screen.getByRole('tab', { name: 'b.md' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Back', exact: true }));
    await screen.findByRole('tab', { name: 'Report A' });
    request.mockResolvedValue({ accepted: false, reason: 'unavailable' });
    act(() =>
      pushArtifactPreview({
        kind: 'reference',
        source: { kind: 'publication', id: 'p' },
        reference: 'https://github.com/example/demo/pull/1',
        file: { path: 'missing.md', headSha: 'a'.repeat(40) },
      })
    );
    await screen.findByText('This file is no longer available to you.');
    expect(screen.getByRole('tab', { name: 'missing.md' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back', exact: true }));
    await screen.findByRole('tab', { name: 'Report A' });
  });

  it('keeps a phone reference live and supports Back and Download', async () => {
    desktop = false;
    render(<ArtifactPreviewPanel fileTabs />);
    request.mockResolvedValue(liveChunk('b'));
    act(() => openArtifactPreview(liveTarget('b')));
    await screen.findByRole('dialog', { name: 'b.md' });
    await screen.findByRole('heading', { name: 'Document b' });
    expect(artifactPreviewStack.value.at(-1)).toEqual(liveTarget('b'));
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('button', { name: 'Download complete file' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the existing single-preview behavior below the desktop breakpoint', async () => {
    desktop = false;
    render(<ArtifactPreviewPanel fileTabs />);
    await open('a');
    await open('b');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Report B' }).id).toBe(
      screen.getByRole('dialog').getAttribute('aria-labelledby')
    );
    expect(screen.queryByRole('button', { name: 'Back', exact: true })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Source', exact: true })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download complete file' })).toBeNull();
    expect(screen.getAllByRole('heading', { name: /Document/ }).length).toBe(1);
    expect(screen.queryByRole('heading', { name: 'Document a' })).toBeNull();
    desktop = true;
    fireEvent(window, new Event('resize'));
    await screen.findByRole('tablist');
    expect(screen.getAllByRole('tab').length).toBe(2);
  });
});
