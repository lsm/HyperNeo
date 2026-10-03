import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../lib/state.ts';
import { SessionStore } from '../../lib/session-store.ts';
import { NeoLive } from '../NeoLive.tsx';

const seams = vi.hoisted(() => ({ useNeo: vi.fn(), request: vi.fn(), event: vi.fn() }));
vi.mock('../useNeo.ts', () => ({ useNeo: seams.useNeo }));
vi.mock('../useNeoVoiceSettings.ts', () => ({ useNeoVoiceSettings: () => false }));
vi.mock('../../hooks/useVoiceRecorder.ts', () => ({
  isVoiceRecordingSupported: () => true,
  useVoiceRecorder: () => ({
    isRecording: false,
    isStarting: false,
    durationLimitHit: false,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    getLevel: () => 0,
    recordingStartedAt: null,
  }),
}));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: () => ({ request: seams.request, onEvent: seams.event }),
    getHub: async () => ({ request: seams.request, onEvent: () => () => {} }),
  },
}));

const root = 'neo:550e8400-e29b-41d4-a716-446655440000';
const holder = 'neo:550e8400-e29b-41d4-a716-446655440001';
const persisted = new Map<string, string>();
const recover = vi.fn();
function remember(text: string, base: string | null, id = root) {
  sessionStorage.setItem(
    key(id),
    JSON.stringify({ sessionId: id, text, base, id: `capture-${text.length}` })
  );
}
const key = (id: string) => `hyperneo_neo_draft_reload_v1.${encodeURIComponent(id)}`;
const read = (id = root) => JSON.parse(sessionStorage.getItem(key(id)) ?? 'null');

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  persisted.clear();
  connectionState.value = 'connected';
  seams.event.mockImplementation(() => () => {});
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
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
      if (method === 'session.get')
        return { session: { metadata: { inputDraft: persisted.get(input.sessionId) ?? '' } } };
      if (method === 'session.update' && input.metadata?.inputDraft !== undefined)
        persisted.set(input.sessionId, input.metadata.inputDraft ?? '');
      if (method === 'operation.invoke') return recover(input as never);
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
  vi.restoreAllMocks();
  sessionStorage.clear();
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
  const snapshot = { ok: true, sessionId: root, concerns: [], work: [], consultations: [] };
  const model = signal({
    sessionId: root,
    snapshot,
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
    setError: vi.fn(),
    open: vi.fn(),
    act: vi.fn(),
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
const value = () =>
  (screen.getByRole('textbox', { name: 'Message Neo' }) as HTMLTextAreaElement).value;

describe('NeoLive reload draft restore', () => {
  beforeEach(() => {
    recover.mockReset();
    recover.mockImplementation(
      async ({ input }: { input: { sessionId: string; text: string } }) => {
        persisted.set(input.sessionId, input.text.trim());
        return { ok: true, notified: true };
      }
    );
  });

  it('restores the newest captured edit over the older saved draft', async () => {
    persisted.set(root, 'Saved baseline');
    remember('Newest visible edit', 'Saved baseline');
    mount();
    await waitFor(() => expect(value()).toBe('Newest visible edit'));
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls[0][0]).toEqual({
      name: 'neo.draft.recover',
      input: { sessionId: root, text: 'Newest visible edit', base: 'Saved baseline' },
    });
    expect(persisted.get(root)).toBe('Newest visible edit');
    expect(read()).toMatchObject({ text: 'Newest visible edit' });
  });

  it('restores a first edit that never reached the saved draft', async () => {
    remember('Typed then reloaded', null);
    mount();
    await waitFor(() => expect(value()).toBe('Typed then reloaded'));
  });

  it.each(['superseded', 'submitted'])(
    'keeps the saved draft and forgets the capture when refused as %s',
    async (reason) => {
      persisted.set(root, 'Newer saved elsewhere');
      remember('Stale edit', 'Saved baseline');
      recover.mockResolvedValue({ ok: false, reason });
      mount();
      await waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(read()).toBeNull());
      expect(value()).toBe('Newer saved elsewhere');
      expect(persisted.get(root)).toBe('Newer saved elsewhere');
    }
  );

  it('keeps the capture without restoring after a transport failure', async () => {
    persisted.set(root, 'Saved baseline');
    remember('Unconfirmed edit', 'Saved baseline');
    recover.mockRejectedValue(new Error('offline'));
    mount();
    await waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(value()).toBe('Saved baseline'));
    expect(read()).toMatchObject({ text: 'Unconfirmed edit' });
  });

  it('never replaces text typed before the recovery answers', async () => {
    persisted.set(root, 'Saved baseline');
    remember('Captured edit', 'Saved baseline');
    let release!: (value: unknown) => void;
    recover.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    mount();
    await waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
    type('Typed after reload');
    await act(async () => {
      release({ ok: true, notified: true });
    });
    expect(value()).toBe('Typed after reload');
  });

  it('does nothing without a captured edit', async () => {
    persisted.set(root, 'Saved baseline');
    mount();
    await waitFor(() => expect(value()).toBe('Saved baseline'));
    expect(recover).not.toHaveBeenCalled();
  });

  it('ignores another session capture', async () => {
    remember('Holder edit', null, holder);
    mount();
    await waitFor(() => expect(seams.request).toHaveBeenCalled());
    expect(recover).not.toHaveBeenCalled();
    expect(value()).toBe('');
  });
});
