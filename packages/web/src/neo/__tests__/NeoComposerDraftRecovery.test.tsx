import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeArtifactPreview, openArtifactPreview } from '../../lib/artifact-preview-store.ts';
import { connectionState } from '../../lib/state.ts';
import { SessionStore } from '../../lib/session-store.ts';
import { NeoLive } from '../NeoLive.tsx';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';
import {
  createNeoIntakeClient,
  type NeoDraft,
  type NeoPendingAsk,
  neoDraftPayload,
} from '../neo-intake.ts';
import { restoreNeoImages, useNeoAttachments } from '../neo-attachments.ts';
import type { NeoPublicEntry } from '../public-conversation.ts';

const seams = vi.hoisted(() => ({ useNeo: vi.fn(), request: vi.fn(), event: vi.fn() }));
const voice = vi.hoisted(() => ({
  recording: false,
  enabled: false,
  start: vi.fn(),
  submit: vi.fn(),
}));
vi.mock('../useNeoVoiceSettings.ts', () => ({
  useNeoVoiceSettings: () => voice.recording || voice.enabled,
}));
vi.mock('../../hooks/useVoiceRecorder.ts', () => ({
  isVoiceRecordingSupported: () => true,
  useVoiceRecorder: () => ({
    isRecording: voice.recording,
    isStarting: false,
    durationLimitHit: false,
    start: voice.start,
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
  voice.submit.mockReset();
  voice.recording = false;
  voice.enabled = false;
  voice.start.mockResolvedValue(undefined);
  useNeoAttachments(root).remove(useNeoAttachments(root).files.map((file) => file.id));
  closeArtifactPreview();
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
  closeArtifactPreview();
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
    projects: [],
    work: [],
  };
  const model = signal({
    sessionId: root,
    snapshot,
    store,
    viewPublicConversation: {
      conversationId: root.slice(4),
      status: 'ready',
      entries: [] as NeoPublicEntry[],
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
    sendRequestId: vi.fn(() => null),
    pendingAsks: [] as readonly NeoPendingAsk[],
    discardSend: vi.fn((_id: string): NeoDraft | null => null),
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

function previewRoute(delay?: Promise<unknown>) {
  const original = seams.request.getMockImplementation()!;
  seams.request.mockImplementation(async (method, input) => {
    if (method !== 'operation.invoke') return original(method, input);
    if (input.name === 'artifact.file.get') {
      if (input.input.artifactId === 'report-a' && delay) return delay;
      const id = input.input.artifactId;
      return {
        accepted: true,
        metadata: {
          context: { kind: 'todo', id: 'fictional-todo' },
          artifact: {
            daemonId: 'd',
            artifactId: id,
            title: `${id}.md`,
            kind: 'markdown',
            byteLength: 8,
          },
          sha256: (id === 'report-a' ? 'a' : 'b').repeat(64),
          createdAt: 1,
          sourcePath: `${id}.md`,
          producer: { adapter: 'hyperneo', id: 's' },
        },
      };
    }
    if (input.name === 'artifact.file.read')
      return {
        accepted: true,
        data: btoa('# Report'),
        nextOffset: 8,
        byteLength: 8,
        sha256: (input.input.artifactId === 'report-a' ? 'a' : 'b').repeat(64),
        complete: true,
      };
    return { accepted: true };
  });
}
function openPreview(id: string) {
  act(() => openArtifactPreview({ kind: 'artifact', artifactId: id }, `${id}.md`));
}
function binding(name: string, hash: string) {
  return screen.queryByText(new RegExp(`To Neo.*${name}.*${hash}`));
}

describe('Neo live preview binding', () => {
  it('keeps an authored draft on its snapshot until explicitly rebound or removed', async () => {
    previewRoute();
    const view = mount();
    openPreview('report-a');
    await waitFor(() => expect(binding('report-a', 'aaaaaaaa')).toBeTruthy());
    type('Discuss this snapshot');
    openPreview('report-b');
    await screen.findByRole('button', { name: 'Use current Preview' });
    expect(binding('report-a', 'aaaaaaaa')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use current Preview' }));
    await waitFor(() => expect(binding('report-b', 'bbbbbbbb')).toBeTruthy());
    openPreview('report-a');
    await screen.findByRole('button', { name: 'Use current Preview' });
    expect(binding('report-b', 'bbbbbbbb')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Preview context' }));
    openPreview('report-b');
    await act(async () => {});
    expect(binding('report-b', 'bbbbbbbb')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
    expect(view.model.value.send.mock.calls[0][0]).not.toHaveProperty('previewContext');
  });
  it('retains a phone preview binding after dismissing the sheet and captures before send', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    previewRoute();
    const view = mount();
    openPreview('report-a');
    await waitFor(() => expect(binding('report-a', 'aaaaaaaa')).toBeTruthy());
    act(() => closeArtifactPreview());
    type('About this report');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
    openPreview('report-b');
    expect(view.model.value.send.mock.calls[0][0]).toMatchObject({
      previewContext: {
        artifactId: 'report-a',
        snapshot: 'a'.repeat(64),
        displayName: 'report-a.md',
        state: 'available',
      },
    });
  });
  it('pins the association before awaiting microphone access on an otherwise empty draft', async () => {
    voice.enabled = true;
    let release!: () => void;
    voice.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    previewRoute();
    mount();
    openPreview('report-a');
    await waitFor(() => expect(binding('report-a', 'aaaaaaaa')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() => expect(voice.start).toHaveBeenCalledOnce());
    openPreview('report-b');
    await screen.findByRole('button', { name: 'Use current Preview' });
    expect(binding('report-a', 'aaaaaaaa')).toBeTruthy();
    await act(async () => {
      release();
    });
    expect(binding('report-a', 'aaaaaaaa')).toBeTruthy();
  });
  it.each(['attachment', 'reading', 'quote'] as const)(
    'keeps the bound snapshot when cleared text leaves %s framing',
    async (framing) => {
      previewRoute();
      const view = mount();
      openPreview('report-a');
      await waitFor(() => expect(binding('report-a', 'aaaaaaaa')).toBeTruthy());
      type('Temporary draft text');
      let finishReading: (() => void) | undefined;
      let reading: Promise<void> | undefined;
      if (framing === 'quote') {
        act(() => {
          view.model.value = {
            ...view.model.value,
            viewPublicConversation: {
              ...view.model.value.viewPublicConversation,
              entries: [
                {
                  kind: 'ask',
                  key: 'quoted-ask',
                  ask: {
                    conversationId: root.slice(4),
                    requestId: 'quoted-ask',
                    askOrigin: { sessionId: root, messageId: 'quoted-ask' },
                    content: 'Original fictional message',
                    sequence: 1,
                    createdAt: '2026-10-25T12:00:00Z',
                  },
                },
              ],
            },
          };
        });
        fireEvent.click(await screen.findByRole('button', { name: 'Reply to your message' }));
      } else if (framing === 'attachment') {
        act(() => {
          restoreNeoImages(root, [{ data: 'YWJj', media_type: 'image/png' }]);
        });
      } else {
        const file = new File(['Synthetic notes'], 'notes.txt', { type: 'text/plain' });
        vi.spyOn(file, 'text').mockImplementation(
          () =>
            new Promise((resolve) => {
              finishReading = () => resolve('Synthetic notes');
            })
        );
        act(() => {
          reading = useNeoAttachments(root).add([file], vi.fn());
        });
        await waitFor(() => expect(finishReading).toBeTypeOf('function'));
        expect(useNeoAttachments(root).reading).toBe(1);
      }
      openPreview('report-b');
      await screen.findByRole('button', { name: 'Use current Preview' });
      try {
        type('');
        expect(binding('report-a', 'aaaaaaaa')).toBeTruthy();
        expect(binding('report-b', 'bbbbbbbb')).toBeNull();
      } finally {
        if (framing === 'reading')
          await act(async () => {
            finishReading!();
            await reading;
          });
      }
      if (framing === 'quote') type('Reply after clearing');
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
      expect(view.model.value.send.mock.calls[0][0]).toMatchObject({
        previewContext: { artifactId: 'report-a', snapshot: 'a'.repeat(64) },
        ...(framing === 'quote' ? { quote: { text: 'Original fictional message' } } : {}),
      });
    }
  );
  it('allows a fully empty draft to follow the current Preview after text is cleared', async () => {
    previewRoute();
    mount();
    openPreview('report-a');
    await waitFor(() => expect(binding('report-a', 'aaaaaaaa')).toBeTruthy());
    type('Temporary text without framing');
    openPreview('report-b');
    await screen.findByRole('button', { name: 'Use current Preview' });
    type('');
    await waitFor(() => expect(binding('report-b', 'bbbbbbbb')).toBeTruthy());
  });
  it('holds an attachment-only draft binding while switching previews', async () => {
    previewRoute();
    const view = mount();
    openPreview('report-a');
    await waitFor(() => expect(binding('report-a', 'aaaaaaaa')).toBeTruthy());
    act(() => {
      restoreNeoImages(root, [{ data: 'YWJj', media_type: 'image/png' }]);
    });
    openPreview('report-b');
    await screen.findByRole('button', { name: 'Use current Preview' });
    expect(binding('report-a', 'aaaaaaaa')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
    expect(view.model.value.send.mock.calls[0][0]).toMatchObject({
      previewContext: { artifactId: 'report-a' },
      images: [{ data: 'YWJj' }],
    });
  });
  it('does not clear a newer binding when an earlier send is accepted', async () => {
    previewRoute();
    const view = mount();
    let release!: (value: unknown) => void;
    view.model.value.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    openPreview('report-a');
    await waitFor(() => expect(binding('report-a', 'aaaaaaaa')).toBeTruthy());
    type('Earlier snapshot comment');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
    openPreview('report-b');
    await waitFor(() => expect(binding('report-b', 'bbbbbbbb')).toBeTruthy());
    type('Later snapshot comment');
    await act(async () => {
      release({ ok: true, created: true, messageId: 'first' });
    });
    expect(value()).toBe('Later snapshot comment');
    expect(binding('report-b', 'bbbbbbbb')).toBeTruthy();
    expect(view.model.value.send.mock.calls[0][0]).toMatchObject({
      previewContext: { artifactId: 'report-a' },
    });
  });
  it('keeps a previously unbound draft unbound when a preview is opened', async () => {
    previewRoute();
    mount();
    type('Unbound before preview');
    openPreview('report-a');
    await screen.findByRole('button', { name: 'Use current Preview' });
    expect(binding('report-a', 'aaaaaaaa')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use current Preview' }));
    expect(binding('report-a', 'aaaaaaaa')).toBeTruthy();
  });
  it('never silently binds existing text when metadata arrives late', async () => {
    let release!: (value: unknown) => void;
    previewRoute(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const view = mount();
    openPreview('report-a');
    type('Unbound thought');
    openPreview('report-b');
    await screen.findByRole('button', { name: 'Use current Preview' });
    await act(async () => {
      release({ accepted: false, reason: 'revoked' });
    });
    expect(binding('report-a', 'aaaaaaaa')).toBeNull();
    expect(binding('report-b', 'bbbbbbbb')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
    expect(view.model.value.send.mock.calls[0][0]).not.toHaveProperty('previewContext');
  });
});

describe('Neo real composer draft recovery', () => {
  it.each([false, true])(
    'restores an unavailable persisted reference, voice draft: %s',
    async (withVoice) => {
      const view = mount();
      await act(async () => {});
      const previewContext: NeoPreviewReference = {
        artifactId: 'registered-report',
        snapshot: 'a'.repeat(64),
        displayName: 'Unavailable report',
        state: 'unavailable',
      };
      view.model.value = {
        ...view.model.value,
        viewPublicConversation: {
          ...view.model.value.viewPublicConversation,
          entries: [
            {
              kind: 'ask',
              key: 'bound-undelivered',
              ask: {
                conversationId: root.slice(4),
                requestId: '20000000-0000-4000-8000-000000000001',
                askOrigin: { sessionId: root, messageId: '20000000-0000-4000-8000-000000000001' },
                content: [{ type: 'text', text: 'Undelivered bound request' }],
                sequence: 1,
                createdAt: '2026-10-25T09:00:00.000Z',
                delivery: { state: 'failed' },
                previewContext,
              },
            },
          ],
        },
      };
      fireEvent.click(await screen.findByRole('button', { name: 'Edit and send again' }));
      await waitFor(() => expect(value()).toBe('Undelivered bound request'));
      expect(
        screen.getByText(/To Neo.*Preview unavailable.*Unavailable report.*aaaaaaaa/)
      ).toBeTruthy();
      if (withVoice) {
        voice.recording = true;
        type('Voice-bound draft');
        voice.submit.mockResolvedValueOnce({
          kind: 'routed',
          recordId: 'bound-voice',
          outcome: { kind: 'insert', transcript: 'Voice addition', autoSend: false },
        });
        const stop = await screen.findByRole('button', {
          name: 'Stop recording and add it to your draft',
        });
        voice.recording = false;
        fireEvent.click(stop);
        await waitFor(() => expect(value()).toBe('Voice-bound draft\nVoice addition'));
        expect(voice.submit.mock.calls[0][0].intent).toBe('draft');
        expect(view.model.value.send).not.toHaveBeenCalled();
      }
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(view.model.value.send).toHaveBeenCalledOnce());
      expect(view.model.value.send.mock.calls[0][0]).toMatchObject({ previewContext });
    }
  );
  it.each([false, true])(
    'retains or explicitly removes a failed-send Preview binding: %s',
    async (remove) => {
      const view = mount();
      await act(async () => {});
      const previewContext: NeoPreviewReference = {
        artifactId: 'registered-report',
        snapshot: 'a'.repeat(64),
        displayName: 'Synthetic report',
        state: 'available',
      };
      let offline = true;
      const request = vi.fn(
        async (_method: string, { input }: { input: ReturnType<typeof neoDraftPayload> }) => {
          if (offline) throw new Error('Disconnected');
          return {
            ok: true,
            requestId: input.requestId,
            messageId: input.requestId,
            created: true,
            ...(input.previewContext
              ? { previewContext: { ...previewContext, ...input.previewContext } }
              : {}),
          };
        }
      );
      const client = createNeoIntakeClient(
        async () => ({ request }) as unknown as MessageHub,
        (pendingAsks) => {
          view.model.value = { ...view.model.value, pendingAsks };
        }
      );
      view.model.value = {
        ...view.model.value,
        send: vi.fn(client.send),
        discardSend: vi.fn(client.discard),
        sendRequestId: vi.fn(() => null),
      };
      await act(async () => {
        await expect(
          client.send({ sessionId: root, text: 'Failed bound request', previewContext })
        ).rejects.toThrow('Disconnected');
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      await waitFor(() => expect(value()).toBe('Failed bound request'));
      expect(screen.getByText(/To Neo.*Synthetic report.*aaaaaaaa/)).toBeTruthy();
      if (remove) fireEvent.click(screen.getByRole('button', { name: 'Remove Preview context' }));
      offline = false;
      type('Edited request');
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(request.mock.calls[1][1].input.previewContext).toEqual(
        remove
          ? undefined
          : {
              artifactId: previewContext.artifactId,
              snapshot: previewContext.snapshot,
            }
      );
      expect(request.mock.calls[1][1].input.content).toBe('Edited request');
      await waitFor(() => expect(screen.queryByText(/To Neo.*Synthetic report/)).toBeNull());
    }
  );
  it('keeps a newer restored binding when an earlier send completes', async () => {
    const view = mount();
    await act(async () => {});
    const contextA: NeoPreviewReference = {
      artifactId: 'report-a',
      snapshot: 'a'.repeat(64),
      displayName: 'Report A',
      state: 'available',
    };
    const contextB: NeoPreviewReference = {
      artifactId: 'report-b',
      snapshot: 'b'.repeat(64),
      displayName: 'Report B',
      state: 'available',
    };
    let acceptFirst = () => {};
    const request = vi.fn(
      async (_method: string, { input }: { input: ReturnType<typeof neoDraftPayload> }) => {
        if (input.content !== 'Edited A') throw new Error('Disconnected');
        return new Promise((resolve) => {
          acceptFirst = () =>
            resolve({
              ok: true,
              requestId: input.requestId,
              messageId: input.requestId,
              created: true,
              previewContext: contextA,
            });
        });
      }
    );
    const client = createNeoIntakeClient(
      async () => ({ request }) as unknown as MessageHub,
      (pendingAsks) => {
        view.model.value = { ...view.model.value, pendingAsks };
      }
    );
    view.model.value = {
      ...view.model.value,
      send: vi.fn(client.send),
      discardSend: vi.fn(client.discard),
    };
    await act(async () => {
      await expect(
        client.send({ sessionId: root, text: 'Failed A', previewContext: contextA })
      ).rejects.toThrow('Disconnected');
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(value()).toBe('Failed A'));
    type('Edited A');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await act(async () => {
      await expect(
        client.send({ sessionId: root, text: 'Failed B', previewContext: contextB })
      ).rejects.toThrow('Disconnected');
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(value()).toBe('Failed B'));
    await act(async () => {
      acceptFirst();
    });
    expect(value()).toBe('Failed B');
    expect(screen.getByText(/To Neo.*Report B.*bbbbbbbb/)).toBeTruthy();
    expect(screen.queryByText(/To Neo.*Report A/)).toBeNull();
  });
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
    const stop = screen.getByRole('button', {
      name: 'Stop recording and keep the text as a draft',
    });
    voice.recording = false;
    fireEvent.click(stop);
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
