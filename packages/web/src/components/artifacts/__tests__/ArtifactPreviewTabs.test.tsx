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
      open: true,
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
    expect(screen.queryByRole('button', { name: /Other files/ })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Other files (3)' }));
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
    const more = screen.getByRole('button', { name: 'Other files (1)' });
    fireEvent.click(more);
    const item = await screen.findByRole('menuitem');
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(more, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('promotes a resolved reference into a tab and closes back to the mounted file', async () => {
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
      params.name === 'artifact.reference.resolve'
        ? { accepted: true, artifact: { artifactId: 'b' } }
        : original(method, params)
    );
    act(() =>
      pushArtifactPreview({
        kind: 'reference',
        source: { kind: 'publication', id: 'p' },
        reference: 'b.md',
      })
    );
    await screen.findByRole('heading', { name: 'Document b' });
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    await screen.findByRole('tab', { name: 'Report B' });
    expect(screen.queryByRole('button', { name: 'Back', exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close Report B' }));
    await screen.findByRole('tablist');
    expect(screen.getByRole('heading', { name: 'Document a' })).toBe(heading);
    const a = screen.getByRole('tab', { name: 'Report A' });
    a.focus();
    fireEvent.keyDown(a, { key: 'Home' });
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Report A' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    );
    expect(document.activeElement).toBe(a);
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    await waitFor(() => expect(document.activeElement).toBe(source));
  });

  it('reuses a known artifact for the same reference without reloading its viewer', async () => {
    render(<ArtifactPreviewPanel fileTabs />);
    await open('a');
    const heading = screen.getByRole('heading', { name: 'Document a' });
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) =>
      params.name === 'artifact.reference.resolve'
        ? { accepted: true, artifact: { artifactId: 'a' } }
        : original(method, params)
    );
    const target = {
      kind: 'reference' as const,
      source: { kind: 'publication' as const, id: 'p' },
      reference: 'a.md',
    };
    act(() => pushArtifactPreview(target));
    await screen.findByRole('tab', { name: 'Report A' });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Document a' })).toBe(heading);
    act(() => pushArtifactPreview({ ...target }));
    await screen.findByRole('tab', { name: 'Report A' });
    expect(
      request.mock.calls.filter(([, call]) => call.name === 'artifact.reference.resolve')
    ).toHaveLength(1);
    expect(request.mock.calls.filter(([, call]) => call.name === 'artifact.file.get')).toHaveLength(
      1
    );
  });

  it.each([false, true])(
    'settles equal-key loading re-taps with suspended=%s',
    async (suspended) => {
      const view = render(<ArtifactPreviewPanel fileTabs />);
      const original = request.getMockImplementation()!;
      let finish!: (value: unknown) => void;
      request.mockImplementation((method, params) =>
        params.name === 'artifact.reference.resolve'
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : original(method, params)
      );
      act(() =>
        openArtifactPreview({
          kind: 'reference',
          source: { kind: 'publication', id: 'p' },
          reference: 'a.md',
        })
      );
      await waitFor(() => expect(finish).toBeTypeOf('function'));
      const target = artifactPreviewStack.value.at(-1)!;
      act(() => openArtifactPreview({ ...target }));
      act(() => openArtifactPreview({ ...target }));
      if (suspended) view.rerender(<ArtifactPreviewPanel fileTabs suspended />);
      await act(async () => {
        finish({ accepted: true, artifact: { artifactId: 'a' } });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (suspended) {
        expect(artifactPreviewStack.value.at(-1)?.kind).toBe('reference');
        expect(
          request.mock.calls.filter(([, call]) => call.name === 'artifact.file.get')
        ).toHaveLength(0);
        view.rerender(<ArtifactPreviewPanel fileTabs />);
      }
      await screen.findByRole('tab', { name: 'Report A' });
      expect(screen.getAllByRole('tab')).toHaveLength(1);
      expect(
        request.mock.calls.filter(([, call]) => call.name === 'artifact.reference.resolve')
      ).toHaveLength(1);
      expect(
        request.mock.calls.filter(([, call]) => call.name === 'artifact.file.get')
      ).toHaveLength(1);
    }
  );

  it('binds cached results to their target when a suspended reference is replaced', async () => {
    const view = render(<ArtifactPreviewPanel fileTabs suspended />);
    const original = request.getMockImplementation()!;
    const pending = new Map<string, (value: unknown) => void>();
    request.mockImplementation((method, params) =>
      params.name === 'artifact.reference.resolve'
        ? new Promise((resolve) => pending.set(params.input.reference, resolve))
        : original(method, params)
    );
    const target = {
      kind: 'reference' as const,
      source: { kind: 'publication' as const, id: 'p' },
      reference: 'a.md',
    };
    act(() => openArtifactPreview(target));
    await waitFor(() => expect(pending.has('a.md')).toBe(true));
    await act(async () => {
      pending.get('a.md')!({ accepted: true, artifact: { artifactId: 'a' } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => openArtifactPreview({ ...target, reference: 'b.md' }));
    view.rerender(<ArtifactPreviewPanel fileTabs />);
    await waitFor(() => expect(pending.has('b.md')).toBe(true));
    expect(artifactPreviewStack.value.at(-1)?.kind).toBe('reference');
    expect(artifactPreviewWorkspace.state.value.files).toHaveLength(0);
    act(() => pending.get('b.md')!({ accepted: true, artifact: { artifactId: 'b' } }));
    await screen.findByRole('tab', { name: 'Report B' });
    expect(screen.queryByRole('tab', { name: 'Report A' })).toBeNull();
    expect(
      request.mock.calls.filter(
        ([, call]) => call.name === 'artifact.file.get' && call.input.artifactId === 'a'
      )
    ).toHaveLength(0);
  });

  it('ignores an old or closed resolve request', async () => {
    render(<ArtifactPreviewPanel fileTabs />);
    const original = request.getMockImplementation()!;
    const pending = new Map<string, (value: unknown) => void>();
    request.mockImplementation((method, params) =>
      params.name === 'artifact.reference.resolve'
        ? new Promise((resolve) => pending.set(params.input.reference, resolve))
        : original(method, params)
    );
    const target = {
      kind: 'reference' as const,
      source: { kind: 'publication' as const, id: 'p' },
      reference: 'a.md',
    };
    act(() => openArtifactPreview(target));
    await waitFor(() => expect(pending.has('a.md')).toBe(true));
    act(() => openArtifactPreview({ ...target, reference: 'b.md' }));
    await waitFor(() => expect(pending.has('b.md')).toBe(true));
    act(() => pending.get('b.md')!({ accepted: true, artifact: { artifactId: 'b' } }));
    await screen.findByRole('tab', { name: 'Report B' });
    await act(async () => {
      pending.get('a.md')!({ accepted: true, artifact: { artifactId: 'a' } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(artifactPreviewStack.value.at(-1)).toEqual({ kind: 'artifact', artifactId: 'b' });
    act(() => openArtifactPreview({ ...target, reference: 'c.md' }));
    await waitFor(() => expect(pending.has('c.md')).toBe(true));
    act(closeArtifactPreview);
    await act(async () => {
      pending.get('c.md')!({ accepted: true, artifact: { artifactId: 'c' } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(artifactPreviewWorkspace.state.value.open).toBe(false);
    act(() => openArtifactPreview({ ...target, reference: 'c.md' }));
    await waitFor(() =>
      expect(
        request.mock.calls.filter(
          ([, call]) =>
            call.name === 'artifact.reference.resolve' && call.input.reference === 'c.md'
        )
      ).toHaveLength(2)
    );
    act(() => pending.get('c.md')!({ accepted: true, artifact: { artifactId: 'c' } }));
    await screen.findByRole('tab', { name: 'Report C' });
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
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back', exact: true }));
    await screen.findByRole('tab', { name: 'Report A' });
  });

  it('promotes a phone reference into the single result presentation', async () => {
    desktop = false;
    render(<ArtifactPreviewPanel fileTabs />);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) =>
      params.name === 'artifact.reference.resolve'
        ? { accepted: true, artifact: { artifactId: 'b' } }
        : original(method, params)
    );
    act(() =>
      openArtifactPreview({
        kind: 'reference',
        source: { kind: 'publication', id: 'p' },
        reference: 'b.md',
      })
    );
    await screen.findByRole('dialog', { name: 'Report B' });
    await waitFor(() =>
      expect(artifactPreviewStack.value.at(-1)).toEqual({ kind: 'artifact', artifactId: 'b' })
    );
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('button', { name: /Back|Source|Close preview/ })).toBeNull();
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
