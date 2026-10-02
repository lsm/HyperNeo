import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../lib/state.ts';
import { SessionStore } from '../../lib/session-store.ts';
import { NeoLive } from '../NeoLive.tsx';

const seams = vi.hoisted(() => ({ useNeo: vi.fn(), request: vi.fn() }));
vi.mock('../useNeo.ts', () => ({ useNeo: seams.useNeo }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: () => ({
      request: seams.request,
      onEvent: () => () => {},
    }),
    getHub: async () => ({ request: seams.request, onEvent: () => () => {} }),
  },
}));

const root = 'neo:550e8400-e29b-41d4-a716-446655440000';
const holder = 'neo:550e8400-e29b-41d4-a716-446655440001';
const persisted = new Map<string, string>();
let slowLoad: Promise<unknown> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  persisted.clear();
  slowLoad = null;
  connectionState.value = 'connected';
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width'),
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
  seams.request.mockImplementation(
    async (
      method: string,
      input: {
        sessionId: string;
        metadata?: { inputDraft?: string | null };
        expected?: string;
      }
    ) => {
      if (method === 'session.get') {
        if (slowLoad) return slowLoad;
        return { session: { metadata: { inputDraft: persisted.get(input.sessionId) ?? '' } } };
      }
      if (method === 'session.update') {
        if (input.metadata?.inputDraft !== undefined)
          persisted.set(input.sessionId, input.metadata.inputDraft ?? '');
        return { success: true };
      }
      if (method === 'session.clearInputDraftIf') {
        const cleared = persisted.get(input.sessionId) === input.expected;
        if (cleared) persisted.set(input.sessionId, '');
        return { cleared };
      }
      return { success: true };
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
  const snapshot = {
    ok: true,
    sessionId: root,
    concerns: [],
    work: [],
    consultations: [],
  };
  const model = signal({
    sessionId: root,
    selectedId: null as string | null,
    snapshot,
    viewSnapshot: snapshot,
    store,
    viewPublicConversation: {
      conversationId: root.slice(4),
      status: 'ready',
      entries: [],
      hasEarlier: false,
      hasMore: false,
    },
    busyWork: null,
    error: null,
    publicAuthors: new Map(),
    setError: vi.fn(),
    open: vi.fn(),
    act: vi.fn(),
    retry: vi.fn(),
    asks: { retry: vi.fn() },
    publications: { refresh: vi.fn() },
    send: vi.fn().mockResolvedValue({ ok: true, created: true, messageId: 'fictional-send' }),
  });
  seams.useNeo.mockImplementation(() => model.value);
  return { ...render(<NeoLive />), model, store };
}
function type(text: string) {
  fireEvent.input(screen.getByRole('textbox', { name: 'Message Neo' }), {
    target: { value: text },
  });
}
function value() {
  return (screen.getByRole('textbox', { name: 'Message Neo' }) as HTMLTextAreaElement).value;
}

describe('Neo real composer draft recovery', () => {
  it('persists typed text and restores it after the real live surface remounts', async () => {
    const first = mount();
    type('Fictional reload draft');
    await waitFor(() => expect(persisted.get(root)).toBe('Fictional reload draft'));
    first.unmount();
    mount();
    await waitFor(() => expect(value()).toBe('Fictional reload draft'));
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(
      false
    );
  });

  it('keeps root and holder drafts isolated through scope loading and return', async () => {
    persisted.set(holder, 'Fictional holder draft');
    const view = mount();
    type('Fictional root draft');
    await waitFor(() => expect(persisted.get(root)).toBe('Fictional root draft'));
    act(() => {
      view.model.value = { ...view.model.value, sessionId: '', selectedId: 'garden' };
    });
    act(() => {
      view.store.activeSessionId.value = holder;
      view.model.value = { ...view.model.value, sessionId: holder };
    });
    await waitFor(() => expect(value()).toBe('Fictional holder draft'));
    type('Edited fictional holder draft');
    await waitFor(() => expect(persisted.get(holder)).toBe('Edited fictional holder draft'));
    act(() => {
      view.store.activeSessionId.value = root;
      view.model.value = { ...view.model.value, sessionId: root, selectedId: null };
    });
    await waitFor(() => expect(value()).toBe('Fictional root draft'));
    expect(persisted.get(holder)).toBe('Edited fictional holder draft');
  });

  it('does not replace fresh typing with a delayed saved draft', async () => {
    let release!: (value: unknown) => void;
    slowLoad = new Promise((resolve) => {
      release = resolve;
    });
    mount();
    type('New fictional edit');
    await act(async () => {
      release({ session: { metadata: { inputDraft: 'Stale draft' } } });
    });
    expect(value()).toBe('New fictional edit');
    await waitFor(() => expect(persisted.get(root)).toBe('New fictional edit'));
  });

  it('clears an accepted submission but retains an edit made while Send is pending', async () => {
    const view = mount();
    type('Submitted fictional draft');
    await waitFor(() => expect(persisted.get(root)).toBe('Submitted fictional draft'));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(value()).toBe(''));
    await waitFor(() => expect(persisted.get(root)).toBe(''));
    let release!: (value: unknown) => void;
    view.model.value.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    type('Second submitted draft');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    type('Newer fictional edit');
    await act(async () => {
      release({ ok: true, created: true, messageId: 'second-send' });
    });
    expect(value()).toBe('Newer fictional edit');
    await waitFor(() => expect(persisted.get(root)).toBe('Newer fictional edit'));
  });
});
