import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../lib/state.ts';
import {
  artifactPreviewWorkspace,
  closeArtifactPreview,
  openArtifactPreview,
  pushArtifactPreview,
  takeArtifactPreviewOpener,
} from '../../lib/artifact-preview-store.ts';
import { NeoLive } from '../NeoLive.tsx';
import { testAskEntry, testTodo } from './neo-test-views.ts';

const { useNeoMock, request } = vi.hoisted(() => ({ useNeoMock: vi.fn(), request: vi.fn() }));
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../NeoGoals.tsx', () => ({ NeoGoals: () => null }));
vi.mock('../NeoConversation.tsx', () => ({ NeoConversation: () => <p>Conversation ready</p> }));
vi.mock('../NeoComposer.tsx', () => ({
  NeoComposer: (props: { draft: string; onDraft: (text: string) => void }) => (
    <textarea
      aria-label="Draft"
      value={props.draft}
      onInput={(event) => props.onDraft(event.currentTarget.value)}
    />
  ),
}));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));
vi.mock('../NeoSessionPane.tsx', () => ({
  NeoSessionPane: ({ onClose }: { onClose: () => void }) => (
    <button onClick={onClose}>Close worker chat</button>
  ),
}));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }), getHubIfConnected: () => null },
}));
let viewport = 1300;
const rootSession = 'neo:550e8400-e29b-41d4-a716-446655440000';
const resize = (width: number) => {
  viewport = width;
  fireEvent(window, new Event('resize'));
};
const open = async (id: string) => {
  act(() => openArtifactPreview({ kind: 'artifact', artifactId: id }, `File ${id}`));
  await screen.findByRole('heading', { name: `Document ${id}` });
};
function mount(empty = false, worker = false) {
  const model = signal({
    sessionId: rootSession,
    snapshot: {
      sessionId: rootSession,
      projects: [],
      work: [],
      todoAsks: empty
        ? []
        : [
            testAskEntry(
              'first',
              'Existing task',
              worker
                ? {
                    state: 'done',
                    todos: [testTodo('worker', { state: 'done', link: '/session/worker' })],
                  }
                : {}
            ),
          ],
    },
    viewPublicConversation: {
      conversationId: rootSession.slice(4),
      status: 'ready',
      entries: [],
      hasEarlier: false,
      hasMore: false,
    },
    store: {
      sessionInfo: signal({ metadata: {} }),
      sdkMessages: signal([]),
      messagesLoaded: signal(true),
      activeSessionId: signal(rootSession),
      loadErrorKind: signal(null),
      agentState: signal({ status: 'idle' }),
      error: signal(null),
      hasMoreMessages: signal(false),
      isWorking: signal(false),
      refresh: vi.fn(),
      destroy: vi.fn(),
    },
    busyWork: null,
    error: null,
    setError: vi.fn(),
    open: vi.fn(),
    send: vi.fn(),
    retry: vi.fn(),
    asks: { retry: vi.fn() },
    publications: { refresh: vi.fn() },
  });
  useNeoMock.mockImplementation(() => model.value);
  return render(<NeoLive />);
}
beforeEach(() => {
  viewport = 1300;
  closeArtifactPreview();
  takeArtifactPreviewOpener();
  connectionState.value = 'connected';
  vi.spyOn(history, 'back').mockImplementation(() => {});
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: viewport >= Number(media.match(/min-width:\s*(\d+)/)?.[1] ?? 99999),
    media,
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
  request.mockImplementation(async (_method, { name, input } = {}) => {
    const id = input?.artifactId;
    const bytes = Buffer.from(`# Document ${id}`);
    if (name === 'artifact.file.get')
      return {
        accepted: true,
        metadata: {
          artifact: {
            daemonId: 'd',
            artifactId: id,
            title: `File ${id}`,
            kind: 'markdown',
            byteLength: bytes.length,
          },
          context: { kind: 'todo', id: 't' },
          sha256: 'f'.repeat(64),
          createdAt: 1,
          sourcePath: `${id}.md`,
          producer: { adapter: 'hyperneo', id: 'worker' },
        },
      };
    if (name === 'artifact.file.read')
      return {
        accepted: true,
        data: bytes.toString('base64'),
        byteLength: bytes.length,
        nextOffset: bytes.length,
        sha256: 'f'.repeat(64),
        complete: true,
      };
    return {};
  });
});
afterEach(() => {
  cleanup();
  closeArtifactPreview();
  takeArtifactPreviewOpener();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Neo preview Work layout', () => {
  it('keeps custom width across tabs/expand, clamps at breakpoints and resets on phone/dismissal', async () => {
    viewport = 900;
    const { container } = mount();
    await open('a');
    const heading = screen.getByRole('heading', { name: 'Document a' });
    const shell = container.querySelector<HTMLElement>('.neo-shell')!;
    const handle = () => screen.getByRole('separator', { name: 'Adjust preview width' });
    expect(handle().getAttribute('aria-valuenow')).toBe('56');
    expect(document.getElementById(handle().getAttribute('aria-controls')!)).toBeTruthy();
    fireEvent.keyDown(handle(), { key: 'End' });
    expect(shell.style.getPropertyValue('--neo-preview-width')).toBe('68%');
    fireEvent.click(screen.getByRole('tab', { name: 'Your work · 1' }));
    expect(handle().getAttribute('aria-controls')).toBe('neo-preview-work-panel');
    fireEvent.click(screen.getByRole('tab', { name: 'File a' }));
    expect(screen.getByRole('heading', { name: 'Document a' })).toBe(heading);
    fireEvent.click(screen.getByRole('button', { name: 'Expand preview' }));
    expect(screen.queryByRole('separator')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore side by side' }));
    expect(handle().getAttribute('aria-valuenow')).toBe('68');
    resize(1500);
    expect(handle().getAttribute('aria-valuenow')).toBe('46');
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(shell.style.getPropertyValue('--neo-preview-width')).toBe('32%');
    resize(900);
    expect(handle().getAttribute('aria-valuenow')).toBe('40');
    resize(719);
    expect(screen.queryByRole('separator')).toBeNull();
    resize(900);
    expect(handle().getAttribute('aria-valuenow')).toBe('56');
    fireEvent.keyDown(handle(), { key: 'End' });
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    await open('b');
    expect(handle().getAttribute('aria-valuenow')).toBe('56');
  });

  it.each([900, 1500])('expands and restores the same file/Work workspace at %s', async (width) => {
    viewport = width;
    const { container } = mount();
    const draft = screen.getByRole('textbox', { name: 'Draft' });
    fireEvent.input(draft, { target: { value: 'Keep this discussion' } });
    const work = container.querySelector<HTMLElement>('.neo-scene-list')!;
    await open('a');
    const heading = screen.getByRole('heading', { name: 'Document a' });
    fireEvent.click(screen.getByRole('button', { name: 'Expand preview' }));
    expect(container.querySelector('.neo-preview-expanded')).toBeTruthy();
    expect(container.querySelector<HTMLElement>('.neo-chat-rail')?.inert).toBe(true);
    expect(screen.queryByRole('textbox', { name: 'Draft' })).toBeNull();
    expect(work.hidden).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Restore side by side' }).getAttribute('aria-pressed')
    ).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Your work · 1' }));
    expect(screen.getByRole('tabpanel', { name: 'Your work · 1' })).toBe(work);
    fireEvent.click(screen.getByRole('tab', { name: 'File a' }));
    expect(screen.getByRole('heading', { name: 'Document a' })).toBe(heading);
    fireEvent.click(screen.getByRole('button', { name: 'Restore side by side' }));
    expect(container.querySelector('.neo-preview-expanded')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe('Keep this discussion');
    expect(container.querySelector('.neo-scene-list')).toBe(work);
    expect(work.hidden).toBe(width < 1440);
    expect(
      request.mock.calls.filter(
        ([, { name, input }]) => name === 'artifact.file.get' && input.artifactId === 'a'
      )
    ).toHaveLength(1);
  });

  it('resets expansion on phone transition and workspace dismissal', async () => {
    const { container } = mount();
    await open('a');
    fireEvent.click(screen.getByRole('button', { name: 'Expand preview' }));
    resize(719);
    await screen.findByRole('heading', { name: 'Document a' });
    expect(
      screen.queryByRole('button', { name: /Expand preview|Restore side by side/ })
    ).toBeNull();
    expect(container.querySelector<HTMLElement>('.neo-chat-rail')?.inert).toBe(false);
    resize(900);
    expect(
      screen.getByRole('button', { name: 'Expand preview' }).getAttribute('aria-pressed')
    ).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Expand preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    await open('b');
    expect(
      screen.getByRole('button', { name: 'Expand preview' }).getAttribute('aria-pressed')
    ).toBe('false');
  });

  it('retains expansion while worker chat temporarily suspends the workspace', async () => {
    mount(false, true);
    await open('a');
    fireEvent.click(screen.getByRole('button', { name: 'Expand preview' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Your work · 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Todo worker' }));
    expect(
      screen.queryByRole('button', { name: /Expand preview|Restore side by side/ })
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close worker chat' }));
    expect(
      screen.getByRole('button', { name: 'Restore side by side' }).getAttribute('aria-pressed')
    ).toBe('true');
  });

  it('retains a Work workspace across worker chat without history cleanup or refocus', async () => {
    mount(false, true);
    const pushed = vi.spyOn(history, 'pushState');
    await open('a');
    fireEvent.click(screen.getByRole('tab', { name: 'Your work · 1' }));
    const preview = screen.getByRole('dialog');
    const opens = pushed.mock.calls.length;
    const backs = vi.mocked(history.back).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Open Todo worker' }));
    const chat = screen.getByRole('button', { name: 'Close worker chat' });
    chat.focus();
    expect(vi.mocked(history.back).mock.calls.length).toBe(backs);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(artifactPreviewWorkspace.state.value.open).toBe(true);
    fireEvent.popState(window);
    expect(artifactPreviewWorkspace.state.value.open).toBe(true);
    fireEvent.click(chat);
    expect(screen.getByRole('dialog')).toBe(preview);
    expect(pushed.mock.calls.length).toBe(opens);
    expect(vi.mocked(history.back).mock.calls.length).toBe(backs);
    expect(document.activeElement).not.toBe(preview);
    expect(screen.getByRole('tab', { name: 'Your work · 1' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    fireEvent.popState(window);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it.each([false, true])('keeps reference navigation intact with existingFile=%s', async (file) => {
    viewport = 900;
    mount();
    if (file) await open('a');
    const handler = request.getMockImplementation()!;
    request.mockImplementation((method, params) =>
      params.name === 'artifact.reference.resolve'
        ? Promise.resolve({ accepted: true, artifact: { artifactId: 'reference' } })
        : handler(method, params)
    );
    act(() =>
      pushArtifactPreview({
        kind: 'reference',
        source: { kind: 'publication', id: 'synthetic-publication' },
        reference: 'reference.md',
      })
    );
    expect(screen.queryByRole('tablist')).toBeNull();
    await screen.findByRole('heading', { name: 'Document reference' });
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    if (file) {
      await screen.findByRole('heading', { name: 'Document a' });
      expect(screen.getByRole('tab', { name: 'Your work · 1' })).toBeTruthy();
      expect(
        request.mock.calls.filter(
          ([, { name, input }]) => name === 'artifact.file.get' && input.artifactId === 'a'
        )
      ).toHaveLength(1);
    } else await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reuses Work and composer state while switching files/Work and wide/compact layouts', async () => {
    const { container } = mount();
    const work = container.querySelector<HTMLElement>('.neo-scene-list')!;
    const task = screen.getByText('Existing task');
    const draft = screen.getByRole('textbox', { name: 'Draft' });
    fireEvent.input(draft, { target: { value: 'Keep this discussion draft' } });
    work.scrollTop = 73;
    fireEvent.scroll(work);
    const rail = container.querySelector<HTMLElement>('.neo-chat-rail')!;
    rail.scrollTop = 175;
    fireEvent.scroll(rail);
    await open('a');
    expect(work.hidden).toBe(true);
    work.scrollTop = 0;
    fireEvent.scroll(work);
    fireEvent.click(screen.getByRole('tab', { name: 'Your work · 1' }));
    expect(screen.getByRole('tabpanel', { name: 'Your work · 1' })).toBe(work);
    expect(work.hidden).toBe(false);
    expect(work.scrollTop).toBe(73);
    expect(screen.getByText('Existing task')).toBe(task);
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe('Keep this discussion draft');
    expect(rail.scrollTop).toBe(175);
    fireEvent.click(screen.getByRole('tab', { name: 'File a' }));
    work.scrollTop = 0;
    fireEvent.scroll(work);
    resize(1500);
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Your work/ })).toBeNull());
    expect(screen.getByRole('region', { name: 'Work scenes' })).toBe(work);
    expect(work.hidden).toBe(false);
    expect(work.scrollTop).toBe(73);
    expect(container.querySelectorAll('.neo-scene-list').length).toBe(1);
    resize(900);
    await screen.findByRole('tab', { name: 'Your work · 1' });
    expect(work.hidden).toBe(true);
    work.scrollTop = 0;
    fireEvent.scroll(work);
    resize(1500);
    await waitFor(() => expect(work.hidden).toBe(false));
    expect(work.scrollTop).toBe(73);
    expect(container.querySelector('.neo-scene-list')).toBe(work);
    expect(rail.scrollTop).toBe(175);
    expect((draft as HTMLTextAreaElement).value).toBe('Keep this discussion draft');
  });

  it('keeps Work available after closing the first active file and the last file', async () => {
    viewport = 1500;
    mount();
    await open('a');
    await open('b');
    expect(screen.queryByRole('tab', { name: /Your work/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'File a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close File a' }));
    const work = await screen.findByRole('tab', { name: 'Your work · 1' });
    expect(work.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(work);
    expect(screen.getByRole('tab', { name: 'File b' })).toBeTruthy();
    expect(screen.getByRole('dialog').getAttribute('aria-owns')).toBe('neo-preview-work-panel');
    fireEvent.click(screen.getByRole('tab', { name: 'File b' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close File b' }));
    expect(screen.getByRole('tab', { name: 'Your work · 1' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(screen.queryByRole('button', { name: 'Close Work' })).toBeNull();
    expect(artifactPreviewWorkspace.state.value.files).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(artifactPreviewWorkspace.state.value.open).toBe(false);
  });

  it('hands keyboard focus between Work tab and the same external Work panel', async () => {
    mount();
    await open('a');
    const workTab = screen.getByRole('tab', { name: 'Your work · 1' });
    workTab.focus();
    fireEvent.click(workTab);
    fireEvent.keyDown(workTab, { key: 'Tab' });
    const panel = screen.getByRole('tabpanel', { name: 'Your work · 1' });
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(workTab);
    fireEvent.keyDown(workTab, { key: 'ArrowRight' });
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'File a' }).getAttribute('aria-selected')).toBe('true')
    );
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'File a' }));
  });

  it.each([false, true])(
    'keeps a mobile surface visible when crossing 720px with Work selected=%s',
    async (work) => {
      viewport = 900;
      const { container } = mount(true);
      const draft = screen.getByRole('textbox', { name: 'Draft' });
      draft.focus();
      await open('a');
      const oldFocus = vi.spyOn(draft, 'focus');
      fireEvent.click(screen.getByRole('tab', { name: 'Your work · 0' }));
      expect(screen.getByText('No work yet.')).toBeTruthy();
      if (!work) fireEvent.click(screen.getByRole('tab', { name: 'File a' }));
      resize(719);
      await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull());
      expect(container.querySelector('.neo-preview-focus')).toBeNull();
      expect(oldFocus).not.toHaveBeenCalled();
      if (work) {
        expect(screen.getByRole('region', { name: 'Work scenes' })).toBeTruthy();
        expect(artifactPreviewWorkspace.state.value.open).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'Close work list' }));
        expect(screen.queryByRole('region', { name: 'Work scenes' })).toBeNull();
        return;
      }
      await screen.findByRole('heading', { name: 'Document a' });
      resize(720);
      await screen.findByRole('tab', { name: 'Your work · 0' });
      expect(container.querySelector('.neo-preview-focus')).toBeTruthy();
    }
  );
});
