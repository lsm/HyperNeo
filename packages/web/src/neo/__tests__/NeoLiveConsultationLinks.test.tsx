import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';
import { NeoLive } from '../NeoLive.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';

const seams = vi.hoisted(() => ({ useNeo: vi.fn(), request: vi.fn() }));
vi.mock('../useNeo.ts', () => ({ useNeo: seams.useNeo }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: () => ({ request: seams.request, onEvent: () => () => {} }),
    getHub: async () => ({ request: seams.request, onEvent: () => () => {} }),
  },
}));
const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
let narrow = false;
beforeEach(() => {
  vi.clearAllMocks();
  narrow = false;
  connectionState.value = 'connected';
  seams.request.mockResolvedValue({ session: { metadata: {} }, success: true });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width') ? !narrow : false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const store = new SessionStore();
  store.activeSessionId.value = root;
  store.messagesLoaded.value = true;
  store.sessionState.value = {
    sessionInfo: { id: root, config: { model: 'haiku' }, metadata: {} },
    agentState: { status: 'idle' },
  } as never;
  const snapshot: NeoSnapshot = {
    ok: true,
    sessionId: root,
    concerns: ['garden', 'other'].map((id) => ({
      id,
      title: `Fictional ${id}`,
      summary: 'Fictional context',
      context: 'Three flowers',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
    work: [
      {
        id: 'joint',
        requestKey: 'work',
        concernId: 'garden',
        originSessionId: root,
        originMessageId: 'ask',
        title: 'Fictional flower execution',
        instruction: 'Native work brief',
        sessionId: null,
        status: 'proposed',
        report: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    consultations: ['joint', 'outside'].map((id) => ({
      id,
      requestKey: id,
      concernId: id === 'joint' ? 'garden' : 'other',
      originSessionId: root,
      originMessageId: 'ask',
      sessionId: `holder-${id}`,
      question: `Full fictional question ${id}`,
      status: 'pending' as const,
      answer: null,
      createdAt: 1,
    })),
  };
  const publication: NeoPublication = {
    conversationId,
    publicationId: '20000000-0000-4000-8000-000000000001',
    askOrigin: { sessionId: root, messageId: 'ask' },
    producerInput: { sessionId: root, messageId: 'ask' },
    shortText: 'An authored fictional answer.',
    fullText: '# Expanded fictional answer\n\nKeep this Markdown.',
    links: [
      { kind: 'consultation', id: 'joint', label: 'Garden context check' },
      { kind: 'work', id: 'joint', label: 'Garden execution' },
      { kind: 'consultation', id: 'outside', label: 'Other context check' },
      { kind: 'consultation', id: 'unknown', label: 'Earlier context check' },
    ],
    sequence: 1,
    createdAt: '2026-10-02T00:00:00Z',
  };
  const page = {
    conversationId,
    status: 'ready' as const,
    nextAfter: 0,
    hasMore: false,
    hasEarlier: false,
  };
  const model = signal({
    sessionId: root,
    selectedId: null as string | null,
    snapshot,
    viewSnapshot: snapshot,
    store,
    viewPublicConversation: projectNeoPublicConversation(
      root,
      { ...page, items: [] },
      {
        ...page,
        items: [publication],
        nextAfter: 1,
      }
    ),
    busyWork: null,
    error: null,
    publicAuthors: new Map(),
    setError: vi.fn(),
    open: vi.fn(),
    act: vi.fn(),
    send: vi.fn(),
    retry: vi.fn(),
    asks: { retry: vi.fn() },
    publications: { refresh: vi.fn() },
  });
  seams.useNeo.mockImplementation(() => model.value);
  return { ...render(<NeoLive />), model };
}
const references = () => within(screen.getByRole('list', { name: 'Related Neo scenes' }));

describe('Neo live public consultation link wiring', () => {
  it.each([false, true])(
    'opens full context detail and preserves draft/Markdown with narrow=%s',
    async (mobile) => {
      narrow = mobile;
      const view = mount();
      fireEvent.click(screen.getByText('Read full response', { exact: true }));
      const entry = view.container.querySelector('[data-public-entry]');
      fireEvent.input(screen.getByRole('textbox', { name: 'Message Neo' }), {
        target: { value: 'Fictional navigation draft' },
      });
      fireEvent.click(references().getByRole('button', { name: 'Garden context check' }));
      const detail = screen.getByRole('region', { name: 'Selected context check' });
      expect(within(detail).getByText('Full fictional question joint')).toBeTruthy();
      expect(within(detail).getByRole('button', { name: 'Stop waiting' })).toBeTruthy();
      expect(view.container.querySelector('.neo-chat-rail')?.hasAttribute('inert')).toBe(mobile);
      expect(view.model.value.act).not.toHaveBeenCalled();
      expect(view.model.value.open).not.toHaveBeenCalled();
      fireEvent.click(within(detail).getByRole('button', { name: 'Back to scenes' }));
      expect(
        (screen.getByRole('textbox', { name: 'Message Neo' }) as HTMLTextAreaElement).value
      ).toBe('Fictional navigation draft');
      expect(
        await screen.findByRole('heading', { name: 'Expanded fictional answer' })
      ).toBeTruthy();
      expect(view.container.querySelector('[data-public-entry]')).toBe(entry);
      expect(view.model.value.act).not.toHaveBeenCalled();
      expect(view.model.value.open).not.toHaveBeenCalled();
    }
  );

  it('does not confuse equal work and context-check IDs', () => {
    const view = mount();
    fireEvent.click(references().getByRole('button', { name: 'Garden execution' }));
    const work = screen.getByRole('region', { name: 'Selected work' });
    expect(within(work).getByText('Native work brief')).toBeTruthy();
    expect(within(work).queryByText('Full fictional question joint')).toBeNull();
    expect(view.model.value.act).not.toHaveBeenCalled();
    fireEvent.click(within(work).getByRole('button', { name: 'Back to scenes' }));
    fireEvent.click(references().getByRole('button', { name: 'Garden context check' }));
    const check = screen.getByRole('region', { name: 'Selected context check' });
    expect(within(check).getByText('Full fictional question joint')).toBeTruthy();
    expect(within(check).queryByText('Native work brief')).toBeNull();
    expect(view.model.value.act).not.toHaveBeenCalled();
  });

  it('keeps unknown and out-of-scope authored labels readable but non-actionable', () => {
    const view = mount();
    act(() => {
      view.model.value = { ...view.model.value, selectedId: 'garden' };
    });
    const refs = references();
    for (const label of ['Earlier context check', 'Other context check']) {
      expect(refs.getByText(label)).toBeTruthy();
      expect(refs.queryByRole('button', { name: label })).toBeNull();
    }
    expect(refs.getByRole('button', { name: 'Garden context check' })).toBeTruthy();
    expect(view.model.value.act).not.toHaveBeenCalled();
    expect(view.model.value.open).not.toHaveBeenCalled();
  });

  it('rechecks scoped receipt membership without replacing an expanded public entry', async () => {
    const view = mount();
    fireEvent.click(screen.getByText('Read full response', { exact: true }));
    const entry = view.container.querySelector('[data-public-entry]');
    act(() => {
      view.model.value = {
        ...view.model.value,
        viewSnapshot: { ...view.model.value.viewSnapshot, consultations: [] },
      };
    });
    expect(references().queryByRole('button', { name: 'Garden context check' })).toBeNull();
    expect(references().getByText('Garden context check')).toBeTruthy();
    expect(references().getByRole('button', { name: 'Garden execution' })).toBeTruthy();
    expect(view.container.querySelector('[data-public-entry]')).toBe(entry);
    expect(await screen.findByRole('heading', { name: 'Expanded fictional answer' })).toBeTruthy();
    expect(view.model.value.act).not.toHaveBeenCalled();
  });

  it('opens queued checks and reported context responses using the same scoped detail path', async () => {
    const view = mount();
    const receipt = view.model.value.viewSnapshot.consultations![0];
    act(() => {
      view.model.value = {
        ...view.model.value,
        viewSnapshot: {
          ...view.model.value.viewSnapshot,
          consultations: [],
          consultationWaiters: [
            {
              ...receipt,
              status: 'queued',
              id: 'joint',
              originMessageId: 'ask',
            },
          ],
        },
      };
    });
    fireEvent.click(references().getByRole('button', { name: 'Garden context check' }));
    expect(
      within(screen.getByRole('region', { name: 'Selected context check' })).getByText(
        'Waiting for context'
      )
    ).toBeTruthy();
    act(() => {
      view.model.value = {
        ...view.model.value,
        viewSnapshot: {
          ...view.model.value.viewSnapshot,
          consultationWaiters: [],
          consultations: [
            {
              ...receipt,
              status: 'reported',
              answer: '**Fictional context answer**',
            },
          ],
        },
      };
    });
    const detail = screen.getByRole('region', { name: 'Selected context check' });
    expect(await within(detail).findByText('Fictional context answer')).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    expect(view.model.value.act).not.toHaveBeenCalled();
  });
});
