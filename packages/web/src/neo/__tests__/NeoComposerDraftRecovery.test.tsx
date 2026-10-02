import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../lib/state.ts';
import { SessionStore } from '../../lib/session-store.ts';
import { NeoLive } from '../NeoLive.tsx';

const seams = vi.hoisted(() => ({ useNeo: vi.fn(), request: vi.fn(), event: vi.fn() }));
const voice = vi.hoisted(() => ({ recording: false, submit: vi.fn() }));
vi.mock('../useNeoVoiceSettings.ts', () => ({ useNeoVoiceSettings: () => voice.recording }));
vi.mock('../../hooks/useVoiceRecorder.ts', () => ({
  isVoiceRecordingSupported: () => true,
  useVoiceRecorder: () => ({
    isRecording: voice.recording,
    isStarting: false,
    durationLimitHit: false,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    getLevel: () => 0,
    recordingStartedAt: null,
  }),
}));
vi.mock('../../lib/voice/voice-submit-pipeline.ts', () => ({
  runVoiceSubmit: voice.submit,
  VOICE_SUBMIT_SILENCE_PEAK_LEVEL: 0.001,
}));
vi.mock('../../lib/voice/voice-audio-store.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/voice/voice-audio-store.ts')>()),
  deleteVoiceRecord: vi.fn(),
}));
vi.mock('../useNeo.ts', () => ({ useNeo: seams.useNeo }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: () => ({
      request: seams.request,
      onEvent: seams.event,
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
  voice.recording = false;
  persisted.clear();
  slowLoad = null;
  seams.event.mockImplementation(() => () => {});
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
  it.each([
    { mode: 'unmount', edited: false },
    { mode: 'navigation', edited: false },
    { mode: 'loading', edited: false },
    { mode: 'unmount', edited: true },
    { mode: 'navigation', edited: true },
    { mode: 'loading', edited: true },
  ])('flushes only unsaved edits on $mode: $edited', async ({ mode, edited }) => {
    const view = mount();
    type('Confirmed fictional draft');
    await waitFor(() => expect(persisted.get(root)).toBe('Confirmed fictional draft'));
    persisted.set(root, 'Newer draft from another surface');
    const rootWrites = () =>
      seams.request.mock.calls.filter(
        ([method, input]) => method === 'session.update' && input.sessionId === root
      ).length;
    const before = rootWrites();
    if (edited) {
      type('Unsaved fictional edit');
      await act(async () => {});
    }
    if (mode !== 'unmount') {
      act(() => {
        view.store.activeSessionId.value = mode === 'loading' ? null : holder;
        view.model.value = {
          ...view.model.value,
          sessionId: mode === 'loading' ? '' : holder,
          selectedId: 'garden',
        };
      });
      await act(async () => {});
    }
    view.unmount();
    await act(async () => {});
    expect(persisted.get(root)).toBe(
      edited ? 'Unsaved fictional edit' : 'Newer draft from another surface'
    );
    if (!edited) expect(rootWrites()).toBe(before);
    mount();
    await waitFor(() =>
      expect(value()).toBe(edited ? 'Unsaved fictional edit' : 'Newer draft from another surface')
    );
  });

  it('does not re-adopt an earlier saved edit when voice recovery waits for Send', async () => {
    let release!: (value: unknown) => void;
    const view = mount();
    type('Earlier fictional saved text');
    await waitFor(() => expect(persisted.get(root)).toBe('Earlier fictional saved text'));
    view.model.value.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    type('Edited fictional accepted text');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
    const listener = seams.event.mock.calls.find(([name]) => name === 'session.voiceLanded')![1];
    await act(async () => {
      listener({ sessionId: root }, { channel: `session:${root}` });
    });
    await act(async () => {
      release({ ok: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(value()).toBe('');
    expect(persisted.get(root)).toBe('');
  });

  it('waits for an earlier in-flight draft save before clearing an accepted edit', async () => {
    let release!: () => void;
    const view = mount();
    await act(async () => {});
    const original = seams.request.getMockImplementation()!;
    seams.request.mockImplementation(async (method, input) => {
      if (method === 'session.update' && input.metadata?.inputDraft === 'Earlier pending save')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return original(method, input);
    });
    type('Earlier pending save');
    await waitFor(() => expect(release).toBeDefined());
    type('Edited accepted submission');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
    expect(value()).toBe('Edited accepted submission');
    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(seams.request).toHaveBeenCalledWith('session.clearInputDraftIf', {
        sessionId: root,
        expected: 'Earlier pending save',
      })
    );
    expect(persisted.get(root)).toBe('');
    await waitFor(() => expect(value()).toBe(''));
    view.unmount();
    mount();
    await waitFor(() => expect(value()).toBe(''));
  });

  it.each([
    { accepted: true, concurrent: false, unmounted: false },
    { accepted: true, concurrent: false, unmounted: true },
    { accepted: false, concurrent: false, unmounted: true },
    { accepted: true, concurrent: true, unmounted: false },
    { accepted: true, concurrent: true, unmounted: true },
  ])(
    'settles an edited saved draft without reviving old text: $accepted/$concurrent/$unmounted',
    async ({ accepted, concurrent, unmounted }) => {
      let release!: (value: unknown) => void;
      const view = mount();
      await act(async () => {});
      type('Earlier fictional saved draft');
      await waitFor(() => expect(persisted.get(root)).toBe('Earlier fictional saved draft'));
      view.model.value.send.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
      type('Edited fictional submission');
      await act(async () => {});
      expect(persisted.get(root)).toBe('Earlier fictional saved draft');
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
      if (concurrent) persisted.set(root, 'Concurrent fictional saved text');
      if (unmounted) view.unmount();
      await act(async () => {
        release(accepted ? { ok: true } : { ok: false });
      });
      const expected = concurrent
        ? 'Concurrent fictional saved text'
        : accepted
          ? ''
          : 'Edited fictional submission';
      await waitFor(() => expect(persisted.get(root)).toBe(expected));
      if (!unmounted) view.unmount();
      mount();
      await waitFor(() => expect(value()).toBe(expected));
    }
  );

  it.each([true, false])('settles pending Send after interrupted loading: %s', async (accepted) => {
    let release!: (value: unknown) => void;
    const view = mount();
    await act(async () => {});
    view.model.value.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    type('Fictional pending loading submission');
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
    act(() => {
      view.model.value = { ...view.model.value, sessionId: '', selectedId: 'garden' };
    });
    await act(async () => {});
    view.unmount();
    await act(async () => {
      release(accepted ? { ok: true, messageId: 'fictional-send' } : { ok: false });
    });
    await waitFor(() =>
      expect(persisted.get(root) ?? '').toBe(accepted ? '' : 'Fictional pending loading submission')
    );
    mount();
    await waitFor(() =>
      expect(value()).toBe(accepted ? '' : 'Fictional pending loading submission')
    );
  });

  it.each(['root', 'holder'])(
    'flushes an unsaved %s draft during interrupted scope loading',
    async (scope) => {
      const view = mount();
      await act(async () => {});
      if (scope === 'holder') {
        act(() => {
          view.store.activeSessionId.value = holder;
          view.model.value = { ...view.model.value, sessionId: holder, selectedId: 'garden' };
        });
        await act(async () => {});
      }
      const owner = scope === 'root' ? root : holder;
      type('Fictional interrupted loading draft');
      await act(async () => {});
      expect(persisted.get(owner) ?? '').toBe('');
      act(() => {
        view.model.value = { ...view.model.value, sessionId: '', selectedId: 'next-garden' };
      });
      await act(async () => {});
      view.unmount();
      await waitFor(() => expect(persisted.get(owner)).toBe('Fictional interrupted loading draft'));
      expect(persisted.get(owner === root ? holder : root) ?? '').toBe('');
    }
  );

  it('does not destructively clear a prior saved draft while scope loading is interrupted', async () => {
    const view = mount();
    type('Fictional submitted draft');
    await waitFor(() => expect(persisted.get(root)).toBe('Fictional submitted draft'));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(value()).toBe(''));
    persisted.set(root, 'Concurrent fictional draft');
    act(() => {
      view.model.value = { ...view.model.value, sessionId: '', selectedId: 'garden' };
    });
    await act(async () => {});
    view.unmount();
    await act(async () => {});
    expect(persisted.get(root)).toBe('Concurrent fictional draft');
  });

  it.each([
    { accepted: true, saved: false },
    { accepted: false, saved: false },
    { accepted: true, saved: true },
    { accepted: false, saved: true },
  ])(
    'settles a Send after unmount without resurrecting accepted text: $accepted/$saved',
    async ({ accepted, saved }) => {
      let release!: (value: unknown) => void;
      const view = mount();
      await act(async () => {});
      view.model.value.send.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
      type('Fictional pending submission');
      await act(async () => {});
      if (saved)
        await waitFor(() => expect(persisted.get(root)).toBe('Fictional pending submission'));
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
      view.unmount();
      expect(persisted.get(root) ?? '').toBe(saved ? 'Fictional pending submission' : '');
      await act(async () => {
        release(
          accepted
            ? { ok: true, created: true, messageId: 'late-send' }
            : { ok: false, reason: 'Fictional refusal' }
        );
      });
      await waitFor(() =>
        expect(persisted.get(root) ?? '').toBe(accepted ? '' : 'Fictional pending submission')
      );
      mount();
      await waitFor(() => expect(value()).toBe(accepted ? '' : 'Fictional pending submission'));
    }
  );

  it('preserves a newer edit while a submission settles after unmount', async () => {
    let release!: (value: unknown) => void;
    const view = mount();
    await act(async () => {});
    view.model.value.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    type('Fictional submitted text');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
    type('Newer fictional edit');
    view.unmount();
    await act(async () => {
      release({ ok: true, created: true, messageId: 'late-send' });
    });
    await waitFor(() => expect(persisted.get(root)).toBe('Newer fictional edit'));
    mount();
    await waitFor(() => expect(value()).toBe('Newer fictional edit'));
  });

  it.each(['mismatch', 'fault'])(
    'preserves concurrent durable text on a mounted clear %s',
    async (outcome) => {
      const view = mount();
      type('Fictional original text');
      await waitFor(() => expect(persisted.get(root)).toBe('Fictional original text'));
      persisted.set(root, 'Concurrent durable text');
      const original = seams.request.getMockImplementation()!;
      seams.request.mockImplementation(async (method, input) => {
        if (method === 'session.clearInputDraftIf') {
          if (outcome === 'fault') throw new Error('Fictional clear fault');
          return { cleared: false };
        }
        return original(method, input);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(value()).toBe(''));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(persisted.get(root)).toBe('Concurrent durable text');
      act(() => {
        view.store.activeSessionId.value = holder;
        view.model.value = { ...view.model.value, sessionId: holder, selectedId: 'garden' };
      });
      await act(async () => {});
      expect(persisted.get(root)).toBe('Concurrent durable text');
      expect(
        seams.request.mock.calls.filter(
          ([method, input]) =>
            method === 'session.update' &&
            input.sessionId === root &&
            input.metadata?.inputDraft === null
        )
      ).toHaveLength(0);
      view.unmount();
      mount();
      await waitFor(() => expect(value()).toBe('Concurrent durable text'));
    }
  );

  it('does not mirror a late root transcript into the current holder draft', async () => {
    let release!: (result: unknown) => void;
    voice.recording = true;
    voice.submit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    persisted.set(holder, 'Fictional holder draft');
    const view = mount();
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop recording and keep the text as a draft' })
    );
    await waitFor(() => expect(voice.submit).toHaveBeenCalledOnce());
    voice.recording = false;
    act(() => {
      view.store.activeSessionId.value = holder;
      view.model.value = { ...view.model.value, sessionId: holder, selectedId: 'garden' };
    });
    await waitFor(() => expect(value()).toBe('Fictional holder draft'));
    await act(async () => {
      release({
        kind: 'routed',
        recordId: 'fictional-recording',
        outcome: {
          kind: 'deliver-unmounted',
          transcript: 'Late fictional root transcript',
          autoSend: false,
        },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(value()).toBe('Fictional holder draft');
    expect(persisted.get(holder)).toBe('Fictional holder draft');
    expect(
      seams.request.mock.calls.filter(
        ([method, input]) =>
          method === 'session.update' &&
          input.sessionId === holder &&
          input.metadata?.inputDraft?.includes('Late fictional root transcript')
      )
    ).toHaveLength(0);
    act(() => {
      view.store.activeSessionId.value = root;
      view.model.value = { ...view.model.value, sessionId: root, selectedId: null };
    });
    await waitFor(() => expect(value()).toBe('Late fictional root transcript'));
    await waitFor(() => expect(persisted.get(root)).toBe('Late fictional root transcript'));
    view.unmount();
    mount();
    await waitFor(() => expect(value()).toBe('Late fictional root transcript'));
  });

  it('persists a voice transcript delivered within its original current scope', async () => {
    voice.recording = true;
    voice.submit.mockResolvedValueOnce({
      kind: 'routed',
      recordId: 'fictional-recording',
      outcome: {
        kind: 'insert',
        transcript: 'Current fictional transcript',
        autoSend: false,
      },
    });
    mount();
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop recording and keep the text as a draft' })
    );
    await waitFor(() => expect(value()).toBe('Current fictional transcript'));
    await waitFor(() => expect(persisted.get(root)).toBe('Current fictional transcript'));
  });

  it('does not flush the prior session while a new scope is loading', async () => {
    const view = mount();
    type('Fictional prior scope draft');
    await waitFor(() => expect(persisted.get(root)).toBe('Fictional prior scope draft'));
    act(() => {
      view.model.value = { ...view.model.value, sessionId: '', selectedId: 'garden' };
    });
    view.unmount();
    await act(async () => {});
    expect(persisted.get(root)).toBe('Fictional prior scope draft');
  });

  it('flushes the latest edit on unmount before the debounce expires', async () => {
    const first = mount();
    await act(async () => {});
    type('Fictional early navigation draft');
    await act(async () => {});
    expect(persisted.get(root)).not.toBe('Fictional early navigation draft');
    type('Latest fictional navigation draft');
    first.unmount();
    await waitFor(() => expect(persisted.get(root)).toBe('Latest fictional navigation draft'));
    mount();
    await waitFor(() => expect(value()).toBe('Latest fictional navigation draft'));
  });

  it('does not clear a concurrently newer persisted draft during unmount', async () => {
    const view = mount();
    type('Original fictional draft');
    await waitFor(() => expect(persisted.get(root)).toBe('Original fictional draft'));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(value()).toBe(''));
    persisted.set(root, 'Concurrent fictional draft');
    view.unmount();
    await act(async () => {});
    expect(persisted.get(root)).toBe('Concurrent fictional draft');
  });

  it('does not resurrect a cleared draft when the live surface unmounts', async () => {
    const view = mount();
    type('Fictional accepted draft');
    await waitFor(() => expect(persisted.get(root)).toBe('Fictional accepted draft'));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(value()).toBe(''));
    view.unmount();
    await waitFor(() => expect(persisted.get(root)).toBe(''));
    mount();
    await act(async () => {});
    expect(value()).toBe('');
  });

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
