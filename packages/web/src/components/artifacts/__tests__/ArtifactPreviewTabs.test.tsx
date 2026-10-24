import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../../lib/state.ts';
import {
  artifactPreviewWorkspace,
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
    expect(document.querySelectorAll('#artifact-title-a').length).toBe(1);
    expect(document.querySelectorAll('#artifact-title-b').length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open preview: Report A' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Report A' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    );
    expect(screen.getAllByRole('tab').length).toBe(2);
  });

  it('retains a viewer mode and scroll position across file switches without reloading it', async () => {
    render(<ArtifactPreviewPanel fileTabs />);
    await open('a');
    fireEvent.click(
      within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Source', exact: true })
    );
    const source = screen.getByRole('tabpanel').querySelector('pre')!;
    source.parentElement!.scrollTop = 73;
    await open('b');
    fireEvent.click(screen.getByRole('tab', { name: 'Report A' }));
    await waitFor(() => expect(screen.getByRole('tabpanel').querySelector('pre')).toBe(source));
    expect(source.parentElement!.scrollTop).toBe(73);
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

  it('keeps references in their existing view and returns to the mounted file viewer', async () => {
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
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back', exact: true }));
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

  it('keeps the existing single-preview behavior below the desktop breakpoint', async () => {
    desktop = false;
    render(<ArtifactPreviewPanel fileTabs />);
    await open('a');
    await open('b');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getAllByRole('heading', { name: /Document/ }).length).toBe(1);
    expect(screen.queryByRole('heading', { name: 'Document a' })).toBeNull();
    desktop = true;
    fireEvent(window, new Event('resize'));
    await screen.findByRole('tablist');
    expect(screen.getAllByRole('tab').length).toBe(2);
  });
});
