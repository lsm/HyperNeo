import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../../lib/state.ts';
import {
  artifactPreviewStack,
  openArtifactPreview,
  closeArtifactPreview,
  takeArtifactPreviewOpener,
} from '../../../lib/artifact-preview-store.ts';
import { ArtifactPreviewPanel } from '../ArtifactPreviewPanel.tsx';
import MarkdownRenderer from '../../chat/MarkdownRenderer.tsx';
import { NeoMessageMenu } from '../../../neo/NeoMessageMenu.tsx';
import { Modal } from '../../ui/Modal.tsx';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));

const source = { kind: 'publication' as const, id: 'p1' };
const tapped = 'https://github.com/Acme/Demo/pull/7';
const headSha = 'c0ffee'.padEnd(40, '0');
const pr = {
  url: 'https://github.com/acme/demo/pull/7',
  repository: 'github.com/acme/demo',
  number: 7,
  title: 'Synthetic layout change',
  body: 'Adds the **layout** report.',
  state: 'OPEN',
  headSha,
  checks: 'passing',
  review: 'approved',
  changedFiles: 2,
  files: [
    { path: 'docs/design/layout.md', additions: 12, deletions: 1 },
    { path: 'src/layout.ts', additions: 3, deletions: 3 },
  ],
  filesTruncated: false,
};
const text = '# Layout design';
const metadata = {
  accepted: true,
  metadata: {
    context: { kind: 'todo', id: 't1' },
    artifact: {
      daemonId: 'd',
      artifactId: 'a1',
      title: 'layout.md',
      kind: 'markdown',
      byteLength: 15,
    },
    sha256: 'f'.repeat(64),
    createdAt: 1,
    sourcePath: 'docs/design/layout.md',
    producer: { adapter: 'hyperneo', id: 's' },
    revision: { kind: 'commit', repository: 'r', commitSha: headSha, blobSha: 'b' },
  },
};
const chunk = {
  accepted: true,
  data: Buffer.from(text).toString('base64'),
  nextOffset: 15,
  byteLength: 15,
  sha256: 'f'.repeat(64),
  complete: true,
};

function route(resolve: (input: Record<string, unknown>) => unknown) {
  request.mockImplementation(async (_method: string, { name, input }) =>
    name === 'artifact.reference.resolve'
      ? resolve(input)
      : name === 'artifact.file.get'
        ? metadata
        : chunk
  );
}

async function openDocument() {
  route(() => ({ accepted: true, artifact: { artifactId: 'a1' } }));
  render(<ArtifactPreviewPanel />);
  act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'a1' }));
  await screen.findByRole('heading', { name: 'Layout design' });
}

beforeEach(() => {
  connectionState.value = 'connected';
  artifactPreviewStack.value = [];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ArtifactPreviewPanel', () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])(
    'keeps the preview during IME Escape: %j',
    async (ime) => {
      await openDocument();
      fireEvent.keyDown(document, { key: 'Escape', ...ime });
      expect(screen.getByRole('dialog')).toBeTruthy();
    }
  );

  it('dismisses the real image lightbox without losing the preview after focus moves', async () => {
    await openDocument();
    render(
      <MarkdownRenderer content="![Synthetic image](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)" />
    );
    const image = await screen.findByRole('img', { name: 'Synthetic image' });
    image.closest('a')!.addEventListener('click', (event) => event.preventDefault());
    fireEvent(image, new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.markdown-image-overlay')).toBeTruthy();
    screen.getByRole('dialog').focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.markdown-image-overlay')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens and closes on ordinary HTTP without crypto.randomUUID', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    await openDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('respects an Escape consumed by the focused textbox', async () => {
    const cancelQuote = vi.fn();
    render(
      <textarea
        aria-label="Quoted reply"
        onKeyDown={(event) => {
          event.preventDefault();
          cancelQuote();
        }}
      />
    );
    await openDocument();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(cancelQuote).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('dismisses a message menu without losing the preview', async () => {
    await openDocument();
    const close = vi.fn();
    render(
      <NeoMessageMenu at={{ x: 10, y: 10 }} actions={['copy']} onPick={() => {}} onClose={close} />
    );
    fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('offers an explicit close action independently of nested navigation', async () => {
    await openDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uses a history entry so browser Back closes without navigating away', async () => {
    const push = vi.spyOn(history, 'pushState');
    route(() => ({ accepted: true, artifact: { artifactId: 'a1' } }));
    render(<ArtifactPreviewPanel />);
    const url = location.href;
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'a1' }));
    await screen.findByRole('heading', { name: 'Layout design' });
    expect(push).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(location.href).toBe(url);
    push.mockRestore();
  });

  it('dismisses the narrow sheet from its uncovered strip', async () => {
    await openDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss preview' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes with a downward swipe but preserves horizontal gestures', async () => {
    await openDocument();
    const panel = screen.getByRole('dialog');
    fireEvent.touchStart(panel, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(panel, { changedTouches: [{ clientX: 240, clientY: 105 }] });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.touchStart(panel, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(panel, { changedTouches: [{ clientX: 105, clientY: 230 }] });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders nothing until something is opened', () => {
    const { container } = render(<ArtifactPreviewPanel />);
    expect(container.innerHTML).toBe('');
  });

  it('opens a PR summary, previews a changed file at its head SHA, and goes back', async () => {
    route((input) =>
      input.file ? { accepted: true, artifact: { artifactId: 'a1' } } : { accepted: true, pr }
    );
    render(<ArtifactPreviewPanel />);
    act(() => openArtifactPreview({ kind: 'reference', source, reference: tapped }));

    const panel = await screen.findByRole('dialog', { name: 'Synthetic layout change' });
    expect(
      within(panel).getByText(
        'github.com/acme/demo #7 · Open · checks passing · approved · head c0ffee0'
      )
    ).toBeTruthy();
    expect(await within(panel).findByText('layout')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /src\/layout\.ts/ })).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: /docs\/design\/layout\.md/ }));
    await screen.findByRole('heading', { name: 'Layout design' });
    expect(request.mock.calls.find((call) => call[1].input?.file)?.[1].input).toEqual({
      sourceMessageOrCard: source,
      requestId: expect.any(String),
      reference: tapped,
      file: { path: 'docs/design/layout.md', headSha },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('dialog', { name: 'Synthetic layout change' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens GitHub only from its explicit action', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    route(() => ({ accepted: true, pr }));
    render(<ArtifactPreviewPanel />);
    act(() => openArtifactPreview({ kind: 'reference', source, reference: pr.url }));
    await screen.findByRole('dialog', { name: 'Synthetic layout change' });
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open on GitHub' }));
    expect(open).toHaveBeenCalledWith(pr.url, '_blank', 'noopener,noreferrer');
  });

  it('asks which context to use when the reference is ambiguous', async () => {
    route((input) =>
      input.context
        ? { accepted: true, artifact: { artifactId: 'a1' } }
        : {
            accepted: false,
            reason: 'ambiguous_context',
            choices: [
              { kind: 'todo', id: 't1' },
              { kind: 'ask', id: 'k1' },
            ],
          }
    );
    render(<ArtifactPreviewPanel />);
    act(() =>
      openArtifactPreview({ kind: 'reference', source, reference: 'docs/design/layout.md' })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Todo t1' }));
    await screen.findByRole('heading', { name: 'Layout design' });
    expect(request.mock.calls.at(-3)?.[1].input.context).toEqual({ kind: 'todo', id: 't1' });
  });

  it('explains a forbidden reference without a path', async () => {
    route(() => ({ accepted: false, reason: 'sensitive_path' }));
    render(<ArtifactPreviewPanel />);
    act(() => openArtifactPreview({ kind: 'reference', source, reference: '/Users/x/.env.md' }));
    await screen.findByText('This reference points outside what the preview may open.');
    expect(document.body.textContent).not.toContain('/Users/x');
  });

  it('closes on Escape and returns focus to what opened it', async () => {
    route(() => ({ accepted: true, artifact: { artifactId: 'a1' } }));
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    render(<ArtifactPreviewPanel />);
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'a1' }));
    await screen.findByRole('heading', { name: 'Layout design' });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('lets Escape close only a Modal opened on top of the panel', async () => {
    await openDocument();
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Question document">
        Synthetic document
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Layout design' })).toBeTruthy();
  });

  it('returns focus to the latest tap when a new preview replaces an open one', async () => {
    route(() => ({ accepted: true, artifact: { artifactId: 'a1' } }));
    const [first, second] = [document.createElement('button'), document.createElement('button')];
    document.body.append(first, second);
    render(<ArtifactPreviewPanel />);
    first.focus();
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'a1' }));
    await screen.findByRole('heading', { name: 'Layout design' });
    second.focus();
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'a1' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByText('Layout design')).toBeNull();
    expect(document.activeElement).toBe(second);
    first.remove();
    second.remove();
  });

  it('closes on Escape pressed in the chat beside it', async () => {
    route(() => ({ accepted: true, artifact: { artifactId: 'a1' } }));
    const menu = document.createElement('button');
    document.body.appendChild(menu);
    render(<ArtifactPreviewPanel />);
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'a1' }));
    await screen.findByRole('heading', { name: 'Layout design' });
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    menu.remove();
  });
});

describe('Neo phone preview sheet', () => {
  let viewport = 390;
  const outerTouch = vi.fn();
  const finger = (x: number, y: number) => ({ clientX: x, clientY: y });
  const start = (node: Element) => fireEvent.touchStart(node, { touches: [finger(100, 100)] });
  const finish = (node: Element, x = 105, y = 230) =>
    fireEvent.touchEnd(node, { changedTouches: [finger(x, y)] });
  const handle = () => document.querySelector('.artifact-preview-handle')!;
  const openPhone = async () => {
    route(() => ({ accepted: true, artifact: { artifactId: 'a1' } }));
    const view = render(
      <div onTouchStart={outerTouch} onTouchMove={outerTouch} onTouchEnd={outerTouch}>
        <button>Open synthetic file</button>
        <ArtifactPreviewPanel
          fileTabs
          work={{ id: 'phone-work', showTab: true, count: 2 }}
          expansion={{ expanded: false, toggle: vi.fn() }}
        />
      </div>
    );
    screen.getByRole('button', { name: 'Open synthetic file' }).focus();
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'a1' }));
    await screen.findByRole('heading', { name: 'Layout design' });
    return view;
  };
  beforeEach(() => {
    viewport = 390;
    closeArtifactPreview();
    takeArtifactPreviewOpener();
    vi.spyOn(history, 'back').mockImplementation(() => {});
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (media) =>
        ({
          matches: viewport >= Number(media.match(/min-width:\s*(\d+)/)?.[1] ?? 99999),
          media,
        }) as MediaQueryList
    );
  });
  afterEach(() => {
    closeArtifactPreview();
    takeArtifactPreviewOpener();
  });

  it('shows one titled result with metadata and no tabs, expand or close cross', async () => {
    await openPhone();
    expect(screen.getByRole('dialog', { name: 'layout.md' })).toBeTruthy();
    expect(screen.getByText('Markdown · 15 B · commit c0ffee0')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('button', { name: /Close preview|Expand preview|Back/ })).toBeNull();
    expect(screen.getAllByRole('region', { name: 'File preview' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss preview' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Open synthetic file' })
    );
  });

  it('leaves content scrolling alone and consumes only a deliberate handle drag', async () => {
    await openPhone();
    const content = screen.getByRole('heading', { name: 'Layout design' });
    start(content);
    const scroll = new TouchEvent('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(scroll, 'touches', { value: [finger(105, 210)] });
    fireEvent(content, scroll);
    finish(content);
    expect(scroll.defaultPrevented).toBe(false);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(outerTouch).not.toHaveBeenCalled();
    content.closest('.overflow-auto')!.scrollTop = 120;
    start(handle());
    const drag = new TouchEvent('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(drag, 'touches', { value: [finger(105, 210)] });
    fireEvent(handle(), drag);
    expect(drag.defaultPrevented).toBe(true);
    finish(handle());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(outerTouch).not.toHaveBeenCalled();
  });

  it.each([
    'horizontal',
    'upward',
    'short',
    'horizontal then down',
    'second start',
    'second move',
    'cancelled',
  ])('does not close from a %s gesture', async (kind) => {
    await openPhone();
    start(handle());
    if (kind === 'second start')
      fireEvent.touchStart(handle(), { touches: [finger(100, 100), finger(150, 100)] });
    if (kind === 'second move')
      fireEvent.touchMove(handle(), { touches: [finger(105, 200), finger(150, 200)] });
    if (kind === 'cancelled') fireEvent.touchCancel(handle());
    if (kind === 'horizontal then down')
      fireEvent.touchMove(handle(), { touches: [finger(180, 105)] });
    finish(
      handle(),
      kind === 'horizontal' ? 260 : 105,
      kind === 'upward' ? 0 : kind === 'short' ? 160 : 230
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it.each(['Escape', 'browser Back'])(
    'keeps %s dismissal without a close cross',
    async (method) => {
      await openPhone();
      const url = location.href;
      if (method === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
      else fireEvent.popState(window);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(location.href).toBe(url);
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Open synthetic file' })
      );
    }
  );

  it('cancels a pending drag when the preview is replaced or grows to desktop', async () => {
    await openPhone();
    start(handle());
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'a1' }));
    finish(handle());
    expect(screen.getByRole('dialog')).toBeTruthy();
    start(handle());
    viewport = 720;
    fireEvent(window, new Event('resize'));
    await screen.findByRole('tablist');
    finish(handle());
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close preview' })).toBeTruthy();
  });
});
