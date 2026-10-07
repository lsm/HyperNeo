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
const persisted = new Map<string, string>();
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

describe('NeoLive ordinary edit reload capture', () => {
  it('captures exact visible text synchronously with its confirmed durable base', async () => {
    persisted.set(root, 'Saved baseline');
    mount();
    await waitFor(() => expect(value()).toBe('Saved baseline'));
    type('  Latest visible edit\nwith Markdown **source**  ');
    expect(read()).toMatchObject({ sessionId: root, base: 'Saved baseline', text: value() });
    expect(persisted.get(root)).toBe('Saved baseline');
  });

  it('does not capture daemon adoption as a human edit', async () => {
    persisted.set(root, 'Recovered server draft');
    mount();
    await waitFor(() => expect(value()).toBe('Recovered server draft'));
    expect(read()).toBeNull();
  });

  it('retires the captured version only after accepted Send', async () => {
    const view = mount();
    type('Accepted edit');
    expect(read()).toMatchObject({ text: 'Accepted edit' });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(value()).toBe('');
    expect(view.model.value.send).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(read()).toBeNull());
  });

  it.each([false, true])(
    'preserves a newer edit version during pending Send: same=%s',
    async (same) => {
      const view = mount();
      let release!: (receipt: unknown) => void;
      view.model.value.send.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
      type('Submitted text');
      const submitted = read();
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      type(same ? 'Submitted text' : 'Newer text');
      const newer = read();
      expect(newer?.id).not.toBe(submitted?.id);
      await act(async () => {
        release({ ok: true, created: true, messageId: 'fictional-send' });
      });
      expect(read()).toEqual(newer);
    }
  );

  it('retains the captured edit when Send is rejected', async () => {
    const view = mount();
    view.model.value.send.mockResolvedValueOnce({ ok: false, reason: 'Fictional refusal' });
    type('Rejected edit');
    const captured = read();
    expect(captured).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(view.model.value.setError).toHaveBeenCalled());
    expect(read()).toEqual(captured);
  });

  it('reports failed capture without blocking the visible edit', () => {
    const view = mount();
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('Blocked');
    });
    type('Still visible');
    expect(value()).toBe('Still visible');
    expect(view.model.value.setError).toHaveBeenCalledWith(expect.stringContaining('reload'));
  });
});
