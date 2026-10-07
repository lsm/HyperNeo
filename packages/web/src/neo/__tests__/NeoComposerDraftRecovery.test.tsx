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
  it.each([false, true])(
    'clears an edited saved draft without clearing concurrent text: %s',
    async (concurrent) => {
      const view = mount();
      await act(async () => {});
      type('Earlier manually saved draft');
      await waitFor(() => expect(persisted.get(root)).toBe('Earlier manually saved draft'));
      type('Latest unsaved manual edit');
      await act(async () => {});
      if (concurrent) persisted.set(root, 'Concurrent manual-clear draft');
      type('');
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(value()).toBe('');
      expect(persisted.get(root)).toBe(concurrent ? 'Concurrent manual-clear draft' : '');
      expect(
        seams.request.mock.calls.some(
          ([method, input]) => method === 'session.update' && input.metadata?.inputDraft === null
        )
      ).toBe(false);
      view.unmount();
      mount();
      await waitFor(() => expect(value()).toBe(concurrent ? 'Concurrent manual-clear draft' : ''));
    }
  );

  it.each([
    { reverse: false, concurrent: false },
    { reverse: true, concurrent: false },
    { reverse: false, concurrent: true },
    { reverse: true, concurrent: true },
  ])(
    'drains both overlapping saves before accepted clear: $reverse/$concurrent',
    async ({ reverse, concurrent }) => {
      const view = mount();
      await act(async () => {});
      const earlier = 'Earlier overlapping save';
      const latest = 'Latest overlapping save';
      const releases = new Map<string, () => void>();
      const original = seams.request.getMockImplementation()!;
      let completed = 0;
      seams.request.mockImplementation(async (method, input) => {
        const text = input.metadata?.inputDraft;
        if (method === 'session.update' && (text === earlier || text === latest)) {
          await new Promise<void>((resolve) => releases.set(text, resolve));
          const result = await original(method, input);
          completed += 1;
          if (completed === 2 && concurrent) persisted.set(root, 'Concurrent overlapping draft');
          return result;
        }
        return original(method, input);
      });
      type(earlier);
      await waitFor(() => expect(releases.has(earlier)).toBe(true));
      type(latest);
      await waitFor(() => expect(releases.has(latest)).toBe(true));
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
      const order = reverse ? [latest, earlier] : [earlier, latest];
      await act(async () => {
        releases.get(order[0])!();
      });
      await act(async () => {
        releases.get(order[1])!();
      });
      expect(value()).toBe('');
      await waitFor(() =>
        expect(persisted.get(root)).toBe(concurrent ? 'Concurrent overlapping draft' : '')
      );
      view.unmount();
      mount();
      await waitFor(() => expect(value()).toBe(concurrent ? 'Concurrent overlapping draft' : ''));
    }
  );

  it('does not write an initial recovered snapshot over newer durable text', async () => {
    persisted.set(root, 'Initial recovered snapshot');
    const original = seams.request.getMockImplementation()!;
    seams.request.mockImplementation(async (method, input) => {
      if (method === 'session.get') {
        const response = { session: { metadata: { inputDraft: 'Initial recovered snapshot' } } };
        persisted.set(root, 'Concurrent initial recovery draft');
        return response;
      }
      return original(method, input);
    });
    mount();
    await waitFor(() => expect(value()).toBe('Initial recovered snapshot'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(persisted.get(root)).toBe('Concurrent initial recovery draft');
    expect(seams.request.mock.calls.filter(([method]) => method === 'session.update')).toHaveLength(
      0
    );
  });

  it('keeps an unconsumed adopted draft through reconnect', async () => {
    persisted.set(root, 'Reload-restored reconnect draft');
    mount();
    await waitFor(() => expect(value()).toBe('Reload-restored reconnect draft'));
    await act(async () => {
      connectionState.value = 'disconnected';
    });
    await act(async () => {
      connectionState.value = 'connected';
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(value()).toBe('Reload-restored reconnect draft');
    expect(persisted.get(root)).toBe('Reload-restored reconnect draft');
    expect(
      seams.request.mock.calls.filter(([method]) => method === 'session.clearInputDraftIf')
    ).toHaveLength(0);
  });

  it('does not re-save an adopted snapshot over a subsequent concurrent update', async () => {
    persisted.set(root, 'Confirmed adoption draft');
    const view = mount();
    await waitFor(() => expect(value()).toBe('Confirmed adoption draft'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const original = seams.request.getMockImplementation()!;
    seams.request.mockImplementation(async (method, input) => {
      if (method === 'session.get' && input.sessionId === root) {
        const draft = persisted.get(root);
        persisted.set(root, 'Concurrent text after the snapshot');
        return { session: { metadata: { inputDraft: draft } } };
      }
      return original(method, input);
    });
    const before = seams.request.mock.calls.filter(
      ([method]) => method === 'session.update'
    ).length;
    const listener = seams.event.mock.calls.find(([name]) => name === 'session.voiceLanded')![1];
    await act(async () => {
      listener({ sessionId: root }, { channel: `session:${root}` });
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(persisted.get(root)).toBe('Concurrent text after the snapshot');
    expect(seams.request.mock.calls.filter(([method]) => method === 'session.update')).toHaveLength(
      before
    );
    view.unmount();
    mount();
    await waitFor(() => expect(value()).toBe('Concurrent text after the snapshot'));
  });

  it.each([
    { mode: 'unmount', edited: false },
    { mode: 'loading', edited: false },
    { mode: 'unmount', edited: true },
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
        view.store.activeSessionId.value = null;
        view.model.value = { ...view.model.value, sessionId: '' };
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
    expect(value()).toBe('');
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
      view.model.value = { ...view.model.value, sessionId: '' };
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

  it('flushes an unsaved draft during interrupted reopen loading', async () => {
    const view = mount();
    await act(async () => {});
    type('Fictional interrupted loading draft');
    await act(async () => {});
    expect(persisted.get(root) ?? '').toBe('');
    act(() => {
      view.model.value = { ...view.model.value, sessionId: '' };
    });
    await act(async () => {});
    view.unmount();
    await waitFor(() => expect(persisted.get(root)).toBe('Fictional interrupted loading draft'));
  });

  it('does not destructively clear a prior saved draft while scope loading is interrupted', async () => {
    const view = mount();
    type('Fictional submitted draft');
    await waitFor(() => expect(persisted.get(root)).toBe('Fictional submitted draft'));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(value()).toBe(''));
    persisted.set(root, 'Concurrent fictional draft');
    act(() => {
      view.model.value = { ...view.model.value, sessionId: '' };
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
        view.store.activeSessionId.value = null;
        view.model.value = { ...view.model.value, sessionId: '' };
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
      view.model.value = { ...view.model.value, sessionId: '' };
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
