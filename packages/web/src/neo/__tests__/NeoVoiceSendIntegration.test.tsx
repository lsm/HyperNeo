import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoComposer } from '../NeoComposer.tsx';

type IntakeInput = { sessionId: string; requestId: string; content: unknown };

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
      return { ok: true, requestId, messageId: requestId, created: true };
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

function renderComposer(draft = 'typed first') {
  const current = signal(draft);
  const onDraft = vi.fn((value: string) => {
    current.value = value;
  });
  const onSend = vi.fn(
    async () => ({ ok: true, requestId: 'typed-1', messageId: 'typed-1', created: true }) as const
  );
  const onError = vi.fn();
  const onTranscript = vi.fn();
  const view = render(
    <NeoComposer
      store={makeStore()}
      sessionId="neo-1"
      draft={current.value}
      onDraft={onDraft}
      onError={onError}
      onTranscript={onTranscript}
      onSend={onSend}
    />
  );
  return {
    current,
    onDraft,
    onSend,
    onError,
    onTranscript,
    rerender: () => view.rerender(view.container),
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
    fireEvent.click(screen.getByTestId('resend-voice-audio'));

    await waitFor(() => expect(asks()).toHaveLength(2));
    expect(asks()[1]?.[1].input).toEqual(asks()[0]?.[1].input);
    expect(reportedErrors(onError)).not.toContain(
      'That recording already has a different message queued.'
    );
    await waitFor(() => expect(store.records.size).toBe(0));
  });

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
