import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoComposer } from '../NeoComposer.tsx';
import type { NeoQuote } from '../neo-intake.ts';
import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';

type IntakeInput = {
  sessionId: string;
  requestId: string;
  content: unknown;
  previewContext?: { artifactId: string; snapshot: string };
};

const voice = vi.hoisted(() => ({ recording: true, stop: vi.fn() }));
vi.mock('../useNeoVoiceSettings.ts', () => ({ useNeoVoiceSettings: () => true }));
vi.mock('../../hooks/useVoiceRecorder.ts', () => ({
  isVoiceRecordingSupported: () => true,
  useVoiceRecorder: () => ({
    isRecording: voice.recording,
    isStarting: false,
    durationLimitHit: false,
    start: vi.fn(),
    stop: voice.stop,
    cancel: vi.fn(),
    getLevel: () => 0,
    recordingStartedAt: null,
  }),
}));
vi.mock('../NeoPreferences.tsx', () => ({ NeoPreferences: () => null }));
const attachmentFiles = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock('../neo-attachments.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  useNeoAttachments: () => ({
    files: attachmentFiles.current,
    reading: 0,
    add: vi.fn(),
    remove: vi.fn(),
  }),
}));
vi.mock('../../hooks/useInterrupt.ts', () => ({
  useInterrupt: () => ({ handleInterrupt: vi.fn(), interrupting: false }),
}));
vi.mock('../../lib/state.ts', () => ({
  connectionState: { value: 'connected', subscribe: () => () => {} },
}));

const hubRequest = vi.fn(
  async (method: string, payload?: unknown): Promise<Record<string, unknown>> => {
    if (method === 'operation.invoke') {
      const invocation = payload as { name: string; input: IntakeInput };
      if (invocation.name !== 'neo.message.send')
        throw new Error(`Unknown operation: ${invocation.name}`);
      const { requestId } = invocation.input;
      return {
        ok: true,
        requestId,
        messageId: requestId,
        created: true,
        ...(invocation.input.previewContext
          ? {
              previewContext: {
                ...invocation.input.previewContext,
                displayName: 'Saved A',
                state: 'available',
              },
            }
          : {}),
      };
    }
    if (method === 'voice.transcribe') return { text: 'spoken second' };
    throw new Error(`No handler for method: ${method}`);
  }
);
const defaultHub = hubRequest.getMockImplementation()!;
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: () => ({ request: hubRequest }),
    getHub: async () => ({ request: hubRequest }),
  },
}));

const parked = vi.hoisted(() => ({ entries: [] as unknown[], fail: false }));
vi.mock('../../lib/voice/voice-transcript-outbox.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  enqueueTranscript: (sessionId: string, text: string, id?: string) => {
    if (parked.fail) return false;
    parked.entries.push({ sessionId, text, id });
    return true;
  },
  removePendingTranscript: vi.fn(),
}));

const store = vi.hoisted(() => ({
  records: new Map<string, Record<string, unknown>>(),
  puts: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../lib/voice/voice-audio-store.ts', () => ({
  listVoiceRecords: async () => [...store.records.values()].map((r) => ({ ...r })),
  getVoiceRecord: async (id: string) => store.records.get(id) ?? null,
  putVoiceRecord: async (entry: Record<string, unknown>) => {
    store.puts.push({ ...entry });
    store.records.set(entry.id as string, { ...entry });
    return true;
  },
  deleteVoiceRecord: async (id: string) => store.records.delete(id),
}));

function makeStore(): SessionStore {
  return {
    sdkMessages: signal([]),
    agentState: signal({ status: 'idle' }),
    sessionInfo: signal({ metadata: {} }),
    hasMoreMessages: signal(false),
    error: signal(null),
    isWorking: signal(false),
    refresh: vi.fn(),
  } as unknown as SessionStore;
}

function renderComposer(
  draft = 'typed first',
  quote?: NeoQuote,
  previewContext?: NeoPreviewReference
) {
  const current = signal(draft);
  const onDraft = vi.fn((value: string) => {
    current.value = value;
  });
  const onSend = vi.fn(
    async () => ({ ok: true, requestId: 'typed-1', messageId: 'typed-1', created: true }) as const
  );
  const onError = vi.fn();
  const onTranscript = vi.fn((text: string) => {
    current.value = [current.value, text].filter(Boolean).join('\n');
  });
  const onCancelQuote = vi.fn();
  const sessionStore = makeStore();
  const composer = (selectedQuote?: NeoQuote) => (
    <NeoComposer
      store={sessionStore}
      sessionId="neo-1"
      draft={current.value}
      onDraft={onDraft}
      onError={onError}
      onTranscript={onTranscript}
      onSend={onSend}
      quote={selectedQuote}
      previewContext={previewContext}
      onCancelQuote={onCancelQuote}
    />
  );
  const view = render(composer(quote));
  return {
    current,
    onDraft,
    onSend,
    onError,
    onTranscript,
    onCancelQuote,
    unmount: view.unmount,
    rerender: (selectedQuote?: NeoQuote) => view.rerender(composer(selectedQuote)),
  };
}

const reportedErrors = (onError: ReturnType<typeof vi.fn>) =>
  onError.mock.calls.map(([message]) => message).filter((message) => message !== '');

const buttonNamed = (name: string | RegExp) =>
  screen.getByRole('button', { name }) as HTMLButtonElement;
const stopControl = () => buttonNamed('Stop recording and keep the text as a draft');
const awaitRecordingComposer = () =>
  waitFor(() => expect(buttonNamed('Stop recording and send the message')).toBeTruthy());
const sendControl = () => buttonNamed('Stop recording and send the message');

const asks = () =>
  hubRequest.mock.calls.filter(
    ([method, payload]) =>
      method === 'operation.invoke' && (payload as { name: string }).name === 'neo.message.send'
  ) as Array<[string, { name: string; input: IntakeInput }]>;

beforeEach(() => {
  vi.clearAllMocks();
  hubRequest.mockReset().mockImplementation(defaultHub);
  store.records.clear();
  store.puts.length = 0;
  parked.entries.length = 0;
  parked.fail = false;
  attachmentFiles.current = [];
  voice.recording = true;
  voice.stop.mockImplementation(async () => {
    voice.recording = false;
    return {
      audioBase64: 'aGk=',
      mimeType: 'audio/wav',
      peakLevel: 0.5,
      hitDurationLimit: false,
    };
  });
});
afterEach(cleanup);

describe('NeoComposer and NeoVoice send integration', () => {
  it.each([false, true])(
    'retries the saved Preview rather than current binding, refused first: %s',
    async (refused) => {
      voice.recording = false;
      const original: NeoPreviewReference = {
        artifactId: 'report-a',
        snapshot: 'a'.repeat(64),
        displayName: 'Saved A',
        state: 'available',
      };
      store.records.set('saved-preview', {
        id: 'saved-preview',
        sessionId: 'neo-1',
        audioBase64: 'aGk=',
        mimeType: 'audio/wav',
        peakLevel: 0.5,
        createdAt: Date.now(),
        intent: 'send',
        sendDraft: 'typed first',
        sendText: 'typed first\nspoken second',
        previewContext: original,
      });
      const { current, onDraft } = renderComposer('typed first', undefined, {
        ...original,
        artifactId: 'report-b',
        snapshot: 'b'.repeat(64),
        displayName: 'Current B',
      });
      if (refused) hubRequest.mockResolvedValueOnce({ ok: false, reason: 'Preview unavailable' });
      fireEvent.click(await screen.findByTestId('resend-voice-audio'));
      if (refused) {
        await waitFor(() =>
          expect(store.records.get('saved-preview')?.sendRefusal).toBe('Preview unavailable')
        );
        expect(parked.entries).toEqual([]);
        await waitFor(() => expect(screen.getByText(/Saved A.*Preview unavailable/)).toBeTruthy());
        await waitFor(() =>
          expect((screen.getByTestId('resend-voice-audio') as HTMLButtonElement).disabled).toBe(
            false
          )
        );
        hubRequest.mockImplementation(defaultHub);
        fireEvent.click(screen.getByTestId('resend-voice-audio'));
      }
      await waitFor(() => expect(store.records.size).toBe(0));
      for (const call of asks())
        expect(call[1].input).toMatchObject({
          requestId: 'saved-preview',
          content: 'typed first\nspoken second',
          previewContext: { artifactId: original.artifactId, snapshot: original.snapshot },
        });
      expect(asks()).toHaveLength(refused ? 2 : 1);
      expect(current.value).toBe('typed first');
      expect(onDraft).not.toHaveBeenCalledWith('');
      expect(screen.getByText(/To Neo.*Current B/)).toBeTruthy();
    }
  );
  it('sends the typed draft and transcript with the selected quote only through normal send', async () => {
    const quote: NeoQuote = { author: 'Neo', text: 'Earlier answer', anchor: 'source' };
    const { current, onTranscript, onSend, rerender } = renderComposer('typed first', quote);
    const stop = await screen.findByRole('button', {
      name: 'Stop recording and add it to your draft',
    });
    fireEvent.click(stop);
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('spoken second'));
    expect(asks()).toHaveLength(0);
    expect(onSend).not.toHaveBeenCalled();
    expect(current.value).toBe('typed first\nspoken second');
    rerender(quote);
    const input = await screen.findByRole('textbox', { name: 'Message Neo' });
    expect(input).toHaveProperty('value', 'typed first\nspoken second');
    expect(screen.getByRole('region', { name: /^Replying to/ }).textContent).toContain(
      'Earlier answer'
    );
    fireEvent.click(buttonNamed('Send message'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith({
      sessionId: 'neo-1',
      text: 'typed first\nspoken second',
      images: [],
      quote: { author: 'Neo', text: 'Earlier answer', anchor: 'source' },
    });
    expect(asks()).toHaveLength(0);
    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it('resumes ordinary voice send after cancelling the quote while recording', async () => {
    const { onSend, onTranscript, onCancelQuote, rerender } = renderComposer('typed first', {
      author: 'Neo',
      text: 'Earlier answer',
      anchor: 'source',
    });
    await screen.findByRole('button', { name: 'Stop recording and add it to your draft' });
    fireEvent.click(buttonNamed('Remove reply'));
    expect(onCancelQuote).toHaveBeenCalledTimes(1);
    rerender();
    await awaitRecordingComposer();
    expect(screen.queryByRole('region', { name: /^Replying to/ })).toBeNull();
    fireEvent.click(sendControl());
    await waitFor(() => expect(asks()).toHaveLength(1));
    expect(asks()[0][1].input.content).toBe('typed first\nspoken second');
    expect(onSend).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });
  it('the existing Send control is the only send affordance and is enabled while recording', async () => {
    renderComposer();
    await awaitRecordingComposer();
    expect(sendControl().disabled).toBe(false);
    expect(screen.getAllByRole('button', { name: /send/i })).toHaveLength(1);
    expect(stopControl().disabled).toBe(false);
  });

  it('keeps Send available but disables Stop once transcription is under way', async () => {
    let releaseTranscribe: (value: Record<string, unknown>) => void = () => {};
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'voice.transcribe')
        return new Promise((resolve) => {
          releaseTranscribe = resolve;
        });
      if (method === 'operation.invoke')
        return { ok: true, requestId: 'rec-1', messageId: 'rec-1', created: true };
      throw new Error(`No handler for method: ${method}`);
    });
    const { onSend } = renderComposer();

    await awaitRecordingComposer();
    fireEvent.click(sendControl());
    await waitFor(() =>
      expect(hubRequest.mock.calls.some(([method]) => method === 'voice.transcribe')).toBe(true)
    );
    expect(buttonNamed('Send message').disabled).toBe(false);
    expect(stopControl().disabled).toBe(true);
    fireEvent.click(buttonNamed('Send message'));

    releaseTranscribe({ text: 'spoken second' });
    await waitFor(() => expect(asks()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asks()).toHaveLength(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('resending a persisted payload is not re-combined with the draft still in the box', async () => {
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'operation.invoke') throw new Error('Request timeout: operation.invoke');
      if (method === 'voice.transcribe') return { text: 'spoken second' };
      throw new Error(`No handler for method: ${method}`);
    });
    const { onError } = renderComposer();

    await awaitRecordingComposer();
    fireEvent.click(sendControl());
    await waitFor(() => expect(asks()).toHaveLength(1));
    const requestId = asks()[0]?.[1].input.requestId as string;
    expect(store.records.get(requestId)?.sendText).toBe('typed first\nspoken second');
    expect(store.records.size).toBe(1);

    hubRequest.mockImplementation(defaultHub);
    fireEvent.click(await screen.findByTestId('resend-voice-audio'));

    await waitFor(() => expect(asks()).toHaveLength(2));
    expect(asks()[1]?.[1].input).toEqual(asks()[0]?.[1].input);
    expect(reportedErrors(onError)).not.toContain(
      'That recording already has a different message queued.'
    );
    await waitFor(() => expect(store.records.size).toBe(0));
  });

  it.each([false, true])(
    'keeps a newer draft when retrying an older voice payload (quoted: %s)',
    async (quoted) => {
      hubRequest.mockImplementation(async (method: string, payload?: unknown) => {
        if (method === 'operation.invoke') throw new Error('Request timeout: operation.invoke');
        return defaultHub(method, payload);
      });
      const { current, onDraft, rerender } = renderComposer();
      await awaitRecordingComposer();
      fireEvent.click(sendControl());
      await screen.findByTestId('resend-voice-audio');
      const original = asks()[0][1].input;
      expect(store.records.get(original.requestId)?.sendText).toBe('typed first\nspoken second');
      current.value = 'new reply';
      rerender(quoted ? { author: 'Neo', text: 'New source', anchor: 'new-source' } : undefined);
      hubRequest.mockImplementation(defaultHub);
      fireEvent.click(screen.getByTestId('resend-voice-audio'));
      await waitFor(() => expect(store.records.size).toBe(0));
      expect(asks()).toHaveLength(2);
      expect(asks()[1][1].input).toEqual(original);
      expect(current.value).toBe('new reply');
      if (quoted) {
        expect(screen.getByRole('region', { name: /^Replying to/ }).textContent).toContain(
          'New source'
        );
      } else {
        expect(screen.queryByRole('region', { name: /^Replying to/ })).toBeNull();
      }
      expect(onDraft).not.toHaveBeenCalledWith('');
    }
  );

  it.each(['quote', 'unmount'])(
    'keeps the typed draft after %s during an accepted voice request',
    async (change) => {
      let accept: () => void = () => {};
      hubRequest.mockImplementation(async (method: string, payload?: unknown) => {
        if (method !== 'operation.invoke') return defaultHub(method, payload);
        const { input } = payload as { input: IntakeInput };
        return new Promise((resolve) => {
          accept = () =>
            resolve({
              ok: true,
              requestId: input.requestId,
              messageId: input.requestId,
              created: true,
            });
        });
      });
      const { current, onDraft, rerender, unmount } = renderComposer();
      await awaitRecordingComposer();
      fireEvent.click(sendControl());
      await waitFor(() => expect(asks()).toHaveLength(1));
      expect(asks()[0][1].input.content).toBe('typed first\nspoken second');
      if (change === 'quote') {
        rerender({ author: 'Neo', text: 'Selected while sending', anchor: 'new-source' });
      } else {
        unmount();
      }
      accept();
      await waitFor(() => expect(store.records.size).toBe(0));
      expect(asks()).toHaveLength(1);
      expect(current.value).toBe('typed first');
      if (change === 'quote') {
        expect(screen.getByRole('region', { name: /^Replying to/ }).textContent).toContain(
          'Selected while sending'
        );
      }
      expect(onDraft).not.toHaveBeenCalledWith('');
    }
  );

  it('with attachments staged, the arrow adds the transcript to the draft instead of sending', async () => {
    attachmentFiles.current = [{ id: 'f1', kind: 'text', name: 'notes.txt', text: 'hi' }];
    const { onTranscript, onError } = renderComposer();
    await waitFor(() =>
      expect(buttonNamed('Stop recording and add it to your draft')).toBeTruthy()
    );
    const arrow = buttonNamed('Stop recording and add it to your draft');
    expect(arrow.disabled).toBe(false);
    expect(arrow.title).toContain('attachments');
    expect(screen.getByRole('status').textContent).toBe(
      'Recording · Stop adds it to your draft; send it with your attachments'
    );

    fireEvent.click(arrow);

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('spoken second'));
    expect(asks()).toHaveLength(0);
    expect(reportedErrors(onError)).toContain(
      'Added to your draft so it goes out with your attachments. Click send when ready.'
    );
    expect(reportedErrors(onError)).not.toContain(
      'Could not send that recording. It is saved below so you can retry.'
    );
  });

  it('persists the typed draft at record creation, before transcription finishes', async () => {
    let releaseTranscribe: (value: Record<string, unknown>) => void = () => {};
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'voice.transcribe')
        return new Promise((resolve) => {
          releaseTranscribe = resolve;
        });
      if (method === 'operation.invoke')
        return { ok: true, requestId: 'rec-1', messageId: 'rec-1', created: true };
      throw new Error(`No handler for method: ${method}`);
    });
    renderComposer();

    await awaitRecordingComposer();
    fireEvent.click(sendControl());

    await waitFor(() => expect(store.records.size).toBe(1));
    const record = [...store.records.values()][0];
    expect(record?.intent).toBe('send');
    expect(record?.sendDraft).toBe('typed first');
    expect(record?.sendText).toBeUndefined();
    expect(asks()).toHaveLength(0);

    releaseTranscribe({ text: 'spoken second' });
    await waitFor(() => expect(asks()).toHaveLength(1));
    expect(asks()[0]?.[1].input.content).toBe('typed first\nspoken second');
  });

  it('sends the typed draft plus the transcript under the durable record id', async () => {
    const { onSend, onDraft, onError } = renderComposer();

    await awaitRecordingComposer();
    fireEvent.click(sendControl());

    await waitFor(() => expect(asks()).toHaveLength(1));
    const requestId = asks()[0]?.[1].input.requestId;
    expect(requestId).toBeTruthy();
    expect(asks()[0]?.[1].input).toEqual({
      sessionId: 'neo-1',
      requestId,
      content: 'typed first\nspoken second',
    });
    expect(hubRequest.mock.calls.map(([method]) => method)).not.toContain('neo.message.send');
    expect(onSend).not.toHaveBeenCalled();
    expect(store.records.size).toBe(0);
    await waitFor(() => expect(onDraft).toHaveBeenCalledWith(''));
    expect(reportedErrors(onError)).toEqual([]);
  });

  it('persists the send payload before the first attempt so a retry is identical', async () => {
    renderComposer();
    await awaitRecordingComposer();
    fireEvent.click(sendControl());

    await waitFor(() => expect(asks()).toHaveLength(1));
    const persisted = store.puts.find((entry) => entry.sendText !== undefined);
    expect(persisted?.sendText).toBe('typed first\nspoken second');
    expect(persisted?.intent).toBe('send');
  });

  it('parks the transcript, then removes the record, on an explicit refusal', async () => {
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'operation.invoke')
        return { ok: false, reason: 'Open a Neo conversation before sending.' };
      if (method === 'voice.transcribe') return { text: 'spoken second' };
      throw new Error(`No handler for method: ${method}`);
    });
    const { onError, onDraft } = renderComposer();

    await awaitRecordingComposer();
    fireEvent.click(sendControl());

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Open a Neo conversation before sending.')
    );
    expect(parked.entries).toEqual([
      { sessionId: 'neo-1', text: 'typed first\nspoken second', id: expect.any(String) },
    ]);
    await waitFor(() => expect(store.records.size).toBe(0));
    expect(onDraft).not.toHaveBeenCalledWith('');
  });

  it('retains the recording and parks nothing when the receipt cannot be read', async () => {
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'operation.invoke') return { ok: true, requestId: 'someone-else' };
      if (method === 'voice.transcribe') return { text: 'spoken second' };
      throw new Error(`No handler for method: ${method}`);
    });
    const { onError } = renderComposer();

    await awaitRecordingComposer();
    fireEvent.click(sendControl());

    await waitFor(() => expect(reportedErrors(onError)).toHaveLength(1));
    expect(parked.entries).toEqual([]);
    expect(store.records.size).toBe(1);
  });

  it('retains the recording when parking the transcript is not durable', async () => {
    parked.fail = true;
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'operation.invoke') return { ok: false, reason: 'Session archived.' };
      if (method === 'voice.transcribe') return { text: 'spoken second' };
      throw new Error(`No handler for method: ${method}`);
    });
    renderComposer();

    await awaitRecordingComposer();
    fireEvent.click(sendControl());

    await waitFor(() => expect(store.records.size).toBe(1));
    expect(parked.entries).toEqual([]);
  });

  it('keeps the recording when the send cannot be confirmed', async () => {
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'operation.invoke') throw new Error('Request timeout: operation.invoke');
      if (method === 'voice.transcribe') return { text: 'spoken second' };
      throw new Error(`No handler for method: ${method}`);
    });
    const { onError } = renderComposer();

    await awaitRecordingComposer();
    fireEvent.click(sendControl());

    await waitFor(() => expect(asks()).toHaveLength(1));
    await waitFor(() => expect(reportedErrors(onError)).toHaveLength(1));
    expect(store.records.size).toBe(1);
  });

  it('Stop stages the transcript as a draft and never sends', async () => {
    const { onSend, onTranscript } = renderComposer();

    fireEvent.click(
      screen.getByRole('button', { name: 'Stop recording and keep the text as a draft' })
    );

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('spoken second'));
    expect(asks()).toHaveLength(0);
    expect(onSend).not.toHaveBeenCalled();
    expect(store.records.size).toBe(0);
  });
});
