vi.mock('../NeoGoals.tsx', () => ({ NeoGoals: () => null }));
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';
import { closeArtifactPreview, openArtifactPreview } from '../../lib/artifact-preview-store.ts';
import { connectionState } from '../../lib/state.ts';
import { SessionStore } from '../../lib/session-store.ts';
import { NeoLive } from '../NeoLive.tsx';
import { restoreNeoImages, useNeoAttachments } from '../neo-attachments.ts';

const seams = vi.hoisted(() => ({ useNeo: vi.fn(), request: vi.fn(), event: vi.fn() }));
vi.mock('../../components/SessionSchedules.tsx', () => ({ SessionSchedules: () => null }));
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
let metadataFault = false;
let metadataGate: Promise<unknown> | null = null;
const reference: NeoPreviewReference = {
  artifactId: 'report-a',
  snapshot: 'a'.repeat(64),
  displayName: 'Original report',
  state: 'available',
};
function remember(
  text: string,
  base: string | null,
  id = root,
  previewContext?: NeoPreviewReference | null
) {
  sessionStorage.setItem(
    key(id),
    JSON.stringify({
      sessionId: id,
      text,
      base,
      id: `capture-${text.length}`,
      ...(previewContext === undefined ? {} : { previewContext }),
    })
  );
}
const key = (id: string) => `hyperneo_neo_draft_reload_v1.${encodeURIComponent(id)}`;
const read = (id = root) => JSON.parse(sessionStorage.getItem(key(id)) ?? 'null');

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  closeArtifactPreview();
  metadataFault = false;
  metadataGate = null;
  persisted.clear();
  useNeoAttachments(root).remove(useNeoAttachments(root).files.map((file) => file.id));
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
        name?: string;
        input?: { artifactId?: string };
        metadata?: { inputDraft?: string | null };
        expected?: string;
      }
    ) => {
      if (method === 'session.get')
        return { session: { metadata: { inputDraft: persisted.get(input.sessionId) ?? '' } } };
      if (method === 'session.update' && input.metadata?.inputDraft !== undefined)
        persisted.set(input.sessionId, input.metadata.inputDraft ?? '');
      if (method === 'operation.invoke') {
        const artifactId = input.input?.artifactId;
        if (input.name === 'artifact.file.get') {
          if (artifactId === 'report-a' && metadataGate) return metadataGate;
          if (artifactId === 'report-a' && metadataFault)
            return { accepted: false, reason: 'unavailable' };
          return {
            accepted: true,
            metadata: {
              context: { kind: 'todo', id: 'synthetic-owner' },
              artifact: {
                daemonId: 'd',
                artifactId,
                title: artifactId === 'report-a' ? 'Original report' : 'Other report',
                kind: 'markdown',
                byteLength: 8,
              },
              sha256: (artifactId === 'report-a' ? 'a' : 'b').repeat(64),
              createdAt: 1,
              sourcePath: 'synthetic.md',
              producer: { adapter: 'hyperneo', id: 's' },
            },
          };
        }
        if (input.name === 'artifact.file.read')
          return { accepted: true, data: btoa('# Report'), nextOffset: 8, complete: true };
        return recover(input as never);
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
  closeArtifactPreview();
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
  const snapshot = { ok: true, sessionId: root, projects: [], work: [] };
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
    sendRequestId: vi.fn(() => null),
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

  it.each([
    { label: 'legacy', stored: undefined, sent: undefined },
    { label: 'explicitly unbound', stored: null, sent: null },
    {
      label: 'available',
      stored: {
        artifactId: 'registered-report',
        snapshot: 'a'.repeat(64),
        displayName: 'Client display metadata',
        state: 'available',
      },
      sent: { artifactId: 'registered-report', snapshot: 'a'.repeat(64) },
    },
    {
      label: 'unavailable',
      stored: {
        artifactId: 'registered-report',
        snapshot: 'a'.repeat(64),
        displayName: 'Client display metadata',
        state: 'unavailable',
      },
      sent: { artifactId: 'registered-report', snapshot: 'a'.repeat(64) },
    },
  ])(
    'projects $label capture into the strict recovery request contract',
    async ({ stored, sent }) => {
      sessionStorage.setItem(
        key(root),
        JSON.stringify({
          sessionId: root,
          text: 'Captured reply',
          base: null,
          id: 'captured-reference',
          ...(stored === undefined ? {} : { previewContext: stored }),
        })
      );
      mount();
      await waitFor(() => expect(recover).toHaveBeenCalledOnce());
      expect(recover.mock.calls[0][0].input).toEqual({
        sessionId: root,
        text: 'Captured reply',
        base: null,
        ...(sent === undefined ? {} : { previewContext: sent }),
      });
    }
  );
  it('captures an original binding, remounts on another Preview, then sends the original snapshot', async () => {
    const first = mount();
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'report-a' }));
    await screen.findByText(/To Neo.*Original report.*aaaaaaaa/);
    type('Original snapshot draft');
    expect(read().previewContext).toEqual(reference);
    first.unmount();
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'report-b' }));
    const second = mount();
    await waitFor(() => expect(value()).toBe('Original snapshot draft'));
    await screen.findByText(/To Neo.*Original report.*aaaaaaaa/);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(second.model.value.send).toHaveBeenCalledOnce());
    expect(second.model.value.send.mock.calls[0][0]).toMatchObject({ previewContext: reference });
    expect(recover.mock.calls[0][0].input.previewContext).toEqual({
      artifactId: reference.artifactId,
      snapshot: reference.snapshot,
    });
  });
  it.each([null, undefined])(
    'does not substitute current Preview for an unbound or legacy capture: %s',
    async (previewContext) => {
      remember('Unbound recovered draft', null, root, previewContext);
      act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'report-b' }));
      const view = mount();
      await waitFor(() => expect(value()).toBe('Unbound recovered draft'));
      expect(screen.queryByText(/To Neo.*Other report/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
      expect(view.model.value.send.mock.calls[0][0]).not.toHaveProperty('previewContext');
    }
  );
  it('retains the original unavailable reference after recovery instead of substituting another', async () => {
    remember('Revoked snapshot draft', null, root, reference);
    metadataFault = true;
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'report-b' }));
    mount();
    await waitFor(() => expect(value()).toBe('Revoked snapshot draft'));
    await screen.findByText(/To Neo.*Preview unavailable.*Original report.*aaaaaaaa/);
  });
  it.each([
    ['remove', false],
    ['rebind', false],
    ['remove', true],
    ['rebind', true],
  ] as const)(
    'keeps newer explicit %s with storage refusal=%s when recovery answers with the same text',
    async (choice, refused) => {
      persisted.set(root, 'Same draft words');
      remember('Same draft words', 'Same draft words', root, reference);
      let release!: (value: unknown) => void;
      recover.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        })
      );
      act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'report-b' }));
      const view = mount();
      await waitFor(() => expect(recover).toHaveBeenCalledOnce());
      if (refused) {
        const storage = window.sessionStorage;
        const proxy = new Proxy(storage, {
          get(target, name) {
            if (name === 'setItem')
              return () => {
                throw new Error('quota');
              };
            const value = Reflect.get(target, name);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        vi.spyOn(window, 'sessionStorage', 'get').mockReturnValue(proxy);
      }
      type('Same draft words');
      fireEvent.click(await screen.findByRole('button', { name: 'Use current Preview' }));
      if (choice === 'remove')
        fireEvent.click(screen.getByRole('button', { name: 'Remove Preview context' }));
      const latest = read();
      await act(async () => {
        release({ ok: true, notified: true });
      });
      expect(read()).toEqual(latest);
      expect(screen.queryByText(/To Neo.*Original report/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
      expect(view.model.value.send.mock.calls[0][0].previewContext?.artifactId).toBe(
        choice === 'remove' ? undefined : 'report-b'
      );
    }
  );
  it('keeps recovered server text out of the composer until its original reference is authorized', async () => {
    remember('Bound recovered reply', null, root, reference);
    let release!: (value: unknown) => void;
    metadataGate = new Promise((resolve) => {
      release = resolve;
    });
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'report-b' }));
    mount();
    await waitFor(() =>
      expect(
        seams.request.mock.calls.some(
          ([, input]) =>
            input.name === 'artifact.file.get' && input.input?.artifactId === 'report-a'
        )
      ).toBe(true)
    );
    expect(persisted.get(root)).toBe('Bound recovered reply');
    for (const [name, callback] of seams.event.mock.calls) {
      if (name === 'session.voiceLanded')
        await act(async () => callback({ sessionId: root }, { channel: `session:${root}` }));
    }
    expect(value()).toBe('');
    expect(screen.queryByText(/To Neo.*Other report/)).toBeNull();
    await act(async () => release({ accepted: false, reason: 'unavailable' }));
    await waitFor(() => expect(value()).toBe('Bound recovered reply'));
    await screen.findByText(/To Neo.*Preview unavailable.*Original report.*aaaaaaaa/);
  });

  it('keeps an original hash unavailable when registered metadata has changed', async () => {
    remember('Exact old snapshot reply', null, root, { ...reference, snapshot: 'c'.repeat(64) });
    mount();
    await waitFor(() => expect(value()).toBe('Exact old snapshot reply'));
    await screen.findByText(/To Neo.*Preview unavailable.*Original report.*cccccccc/);
  });

  it('captures explicit rebind and removal without changing the text', async () => {
    const view = mount();
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'report-a' }));
    await screen.findByText(/To Neo.*Original report.*aaaaaaaa/);
    type('Unchanged words');
    const first = read();
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'report-b' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use current Preview' }));
    expect(read()).toMatchObject({
      text: first.text,
      previewContext: { artifactId: 'report-b', snapshot: 'b'.repeat(64) },
    });
    expect(read().id).not.toBe(first.id);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Preview context' }));
    expect(read()).toMatchObject({ text: first.text, previewContext: null });
    view.unmount();
    const restored = mount();
    await waitFor(() => expect(value()).toBe(first.text));
    expect(screen.queryByText(/To Neo.*Other report/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(restored.model.value.send).toHaveBeenCalledOnce());
    expect(restored.model.value.send.mock.calls[0][0]).not.toHaveProperty('previewContext');
  });

  it('does not restore original context after newer typing during metadata authorization', async () => {
    remember('Captured old draft', null, root, reference);
    let release!: (value: unknown) => void;
    metadataGate = new Promise((resolve) => {
      release = resolve;
    });
    mount();
    await waitFor(() =>
      expect(seams.request.mock.calls.some(([, input]) => input.name === 'artifact.file.get')).toBe(
        true
      )
    );
    type('Newer visible draft');
    await act(async () => {
      release({ accepted: false, reason: 'unavailable' });
    });
    expect(value()).toBe('Newer visible draft');
    expect(screen.queryByText(/To Neo.*Original report/)).toBeNull();
  });
  it('releases Preview auto-binding and later server-draft adoption after a local edit supersedes recovery', async () => {
    remember('Old captured reply', null, root, reference);
    let release!: (value: unknown) => void;
    metadataGate = new Promise((resolve) => {
      release = resolve;
    });
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'report-b' }));
    mount();
    await waitFor(() =>
      expect(
        seams.request.mock.calls.some(
          ([, input]) =>
            input.name === 'artifact.file.get' && input.input?.artifactId === 'report-a'
        )
      ).toBe(true)
    );
    type('New local edit');
    type('');
    await waitFor(() => expect(persisted.get(root)).toBe(''));
    await act(async () => release({ accepted: false, reason: 'unavailable' }));
    await screen.findByText(/To Neo.*Other report.*bbbbbbbb/);
    expect(value()).toBe('');
    persisted.set(root, 'Later landed transcript');
    for (const [name, callback] of seams.event.mock.calls) {
      if (name === 'session.voiceLanded')
        await act(async () => callback({ sessionId: root }, { channel: `session:${root}` }));
    }
    await waitFor(() => expect(value()).toBe('Later landed transcript'));
    expect(screen.queryByText(/To Neo.*Original report/)).toBeNull();
  });

  it.each(['quote', 'cancel quote', 'attachment', 'reading'] as const)(
    'settles pending recovery when only %s framing changes',
    async (framing) => {
      remember('Old captured reply', null, root, reference);
      const original = read();
      let release!: (value: unknown) => void;
      metadataGate = new Promise((resolve) => {
        release = resolve;
      });
      act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'report-b' }));
      const view = mount();
      await waitFor(() =>
        expect(
          seams.request.mock.calls.some(
            ([, input]) =>
              input.name === 'artifact.file.get' && input.input?.artifactId === 'report-a'
          )
        ).toBe(true)
      );
      let finish!: () => void;
      let reading: Promise<void> | undefined;
      if (framing === 'quote' || framing === 'cancel quote') {
        act(() => {
          view.model.value = {
            ...view.model.value,
            viewPublicConversation: {
              ...view.model.value.viewPublicConversation,
              entries: [
                {
                  kind: 'ask',
                  key: 'quoted',
                  ask: {
                    conversationId: root.slice(4),
                    requestId: 'quoted',
                    askOrigin: { sessionId: root, messageId: 'quoted' },
                    content: 'Synthetic quoted thought',
                    sequence: 1,
                    createdAt: '2026-10-25T12:00:00Z',
                  },
                },
              ],
            },
          } as never;
        });
        fireEvent.click(await screen.findByRole('button', { name: 'Reply to your message' }));
        if (framing === 'cancel quote')
          fireEvent.click(screen.getByRole('button', { name: 'Remove reply' }));
      } else if (framing === 'attachment') {
        act(() => {
          restoreNeoImages(root, [{ data: 'YWJj', media_type: 'image/png' }]);
        });
      } else {
        const file = new File(['Synthetic notes'], 'notes.txt', { type: 'text/plain' });
        vi.spyOn(file, 'text').mockReturnValue(
          new Promise((resolve) => {
            finish = () => resolve('Synthetic notes');
          })
        );
        act(() => {
          reading = useNeoAttachments(root).add([file], vi.fn());
        });
      }
      try {
        await waitFor(() => expect(read()?.id).not.toBe(original.id));
        expect(read()).toMatchObject({ text: '', previewContext: null });
        await waitFor(() => expect(persisted.get(root)).toBe(''));
        await act(async () => release({ accepted: false, reason: 'unavailable' }));
        expect(value()).toBe('');
        expect(screen.queryByText(/To Neo.*Original report/)).toBeNull();
        persisted.set(root, 'Newly landed dictation');
        for (const [name, callback] of seams.event.mock.calls) {
          if (name === 'session.voiceLanded')
            await act(async () => callback({ sessionId: root }, { channel: `session:${root}` }));
        }
        await waitFor(() => expect(value()).toBe('Newly landed dictation'));
      } finally {
        if (reading)
          await act(async () => {
            finish();
            await reading;
          });
      }
    }
  );

  it.each(['refused', 'forget failed'] as const)(
    'resumes later draft adoption after sending during pending recovery: %s',
    async (outcome) => {
      remember('Original reload capture', null, root, reference);
      let release!: (value: unknown) => void;
      recover.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        })
      );
      const view = mount();
      await waitFor(() => expect(recover).toHaveBeenCalledOnce());
      type('New submitted text');
      if (outcome === 'refused')
        view.model.value.send.mockResolvedValueOnce({ ok: false, reason: 'Synthetic refusal' });
      else {
        const storage = window.sessionStorage;
        vi.spyOn(window, 'sessionStorage', 'get').mockReturnValue(
          new Proxy(storage, {
            get(target, name) {
              if (name === 'removeItem')
                return () => {
                  throw new Error('Storage unavailable');
                };
              const value = Reflect.get(target, name);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          })
        );
      }
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
      await act(async () => release({ ok: true }));
      expect(read()?.text).toBe('New submitted text');
      persisted.set(root, 'Later dictation after the send');
      for (const [name, callback] of seams.event.mock.calls) {
        if (name === 'session.voiceLanded')
          await act(async () => callback({ sessionId: root }, { channel: `session:${root}` }));
      }
      await waitFor(() => expect(value()).toBe('Later dictation after the send'));
    }
  );

  it('resumes adoption after returning from another edited session before send cleanup finishes', async () => {
    remember('Original reload capture', null, root, reference);
    metadataGate = new Promise(() => {});
    let finishClear!: (value: unknown) => void;
    const clear = new Promise((resolve) => {
      finishClear = resolve;
    });
    const request = seams.request.getMockImplementation()!;
    seams.request.mockImplementation(async (method, input) => {
      if (method === 'session.clearInputDraftIf') {
        await clear;
        return request(method, input);
      }
      return request(method, input);
    });
    const view = mount();
    await waitFor(() => expect(recover).toHaveBeenCalledOnce());
    type('Submitted before visiting another session');
    view.model.value.send.mockResolvedValueOnce({ ok: false, reason: 'Synthetic refusal' });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() =>
      expect(seams.request.mock.calls.some(([name]) => name === 'session.clearInputDraftIf')).toBe(
        true
      )
    );
    act(() => {
      view.store.activeSessionId.value = holder;
      view.model.value = { ...view.model.value, sessionId: holder };
    });
    type('Only the other session was edited');
    type('');
    act(() => {
      view.store.activeSessionId.value = root;
      view.model.value = { ...view.model.value, sessionId: root };
    });
    await act(async () => finishClear({}));
    persisted.set(root, 'Dictation after returning');
    for (const [name, callback] of seams.event.mock.calls) {
      if (name === 'session.voiceLanded')
        await act(async () => callback({ sessionId: root }, { channel: `session:${root}` }));
    }
    await waitFor(() => expect(value()).toBe('Dictation after returning'));
    expect(read()?.text).toBe('Submitted before visiting another session');
  });

  it('does not show an old send handoff failure in a different session', async () => {
    remember('Original reload capture', null, root, reference);
    let release!: (value: unknown) => void;
    recover.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const request = seams.request.getMockImplementation()!;
    seams.request.mockImplementation(async (method, input) => {
      if (method === 'session.clearInputDraftIf') throw new Error('Old session handoff failed');
      return request(method, input);
    });
    const view = mount();
    await waitFor(() => expect(recover).toHaveBeenCalledOnce());
    type('Submitted before scope change');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
    act(() => {
      view.store.activeSessionId.value = holder;
      view.model.value = { ...view.model.value, sessionId: holder };
    });
    view.model.value.setError.mockClear();
    await act(async () => release({ ok: true }));
    await waitFor(() =>
      expect(seams.request.mock.calls.some(([name]) => name === 'session.clearInputDraftIf')).toBe(
        true
      )
    );
    expect(view.model.value.setError).not.toHaveBeenCalled();
  });

  it('does not capture the dropped Preview after a fully empty reset', async () => {
    const first = mount();
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'report-a' }));
    await screen.findByText(/To Neo.*Original report.*aaaaaaaa/);
    type('Reply to A');
    act(() => closeArtifactPreview());
    type('');
    expect(read()).toMatchObject({ text: '', previewContext: null });
    first.unmount();
    act(() => openArtifactPreview({ kind: 'artifact', artifactId: 'report-b' }));
    const second = mount();
    await waitFor(() => expect(recover).toHaveBeenCalledOnce());
    await act(async () => {});
    type('A new reply');
    expect(screen.queryByText(/To Neo.*Original report/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(second.model.value.send).toHaveBeenCalledOnce());
    expect(second.model.value.send.mock.calls[0][0].previewContext?.artifactId).not.toBe(
      'report-a'
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
