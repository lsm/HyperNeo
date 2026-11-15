import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoVoice } from '../NeoVoice.tsx';

const rec = vi.hoisted(() => ({
  isRecording: false,
  isStarting: false,
  durationLimitHit: false,
  sessionId: null as string | null,
  ownerId: null as string | null,
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
}));
rec.start.mockImplementation(async (_ownerId: string, ownerSessionId: string) => {
  rec.ownerId = _ownerId;
  rec.sessionId = ownerSessionId;
  rec.isRecording = true;
});
rec.stop.mockImplementation(async () => {
  if (!rec.isRecording && !rec.durationLimitHit) throw new Error('Voice recorder is not recording');
  rec.isRecording = false;
  rec.durationLimitHit = false;
  rec.sessionId = null;
  rec.ownerId = null;
  return { audioBase64: 'cmVj', mimeType: 'audio/wav', peakLevel: 0.5 };
});
rec.cancel.mockImplementation(async () => {
  rec.isRecording = false;
  rec.isStarting = false;
  rec.durationLimitHit = false;
  rec.sessionId = null;
  rec.ownerId = null;
});
vi.mock('../../lib/voice/voice-recorder-store.ts', () => ({
  isVoiceRecordingSupported: () => true,
  voiceRecorderStore: {
    isRecording: {
      get value() {
        return rec.isRecording;
      },
    },
    isStarting: {
      get value() {
        return rec.isStarting;
      },
    },
    durationLimitHit: {
      get value() {
        return rec.durationLimitHit;
      },
    },
    recordingSessionId: {
      get value() {
        return rec.sessionId;
      },
    },
    recordingOwnerId: {
      get value() {
        return rec.ownerId;
      },
    },
    recordingStartedAt: { value: null },
    recordingScopeId: { value: null },
    recordingTaskId: { value: null },
    recordingCursor: { value: null },
    start: rec.start,
    stop: rec.stop,
    cancel: rec.cancel,
    getLevel: () => 0,
    setPcmTap: vi.fn(),
    orphan: (ownerId: string) => {
      if (rec.ownerId === ownerId) rec.ownerId = null;
    },
    adopt: vi.fn(() => false),
  },
}));

const records = vi.hoisted(() => ({ map: new Map<string, Record<string, unknown>>() }));
vi.mock('../../lib/voice/voice-audio-store.ts', () => ({
  listVoiceRecords: async () => [...records.map.values()].map((r) => ({ ...r })),
  getVoiceRecord: async (id: string) => records.map.get(id) ?? null,
  putVoiceRecord: async (entry: Record<string, unknown>) => {
    records.map.set(entry.id as string, { ...entry });
    return true;
  },
  deleteVoiceRecord: async (id: string) => records.map.delete(id),
}));

const hubRequest = vi.fn(async (method: string) => {
  if (method === 'voice.transcribe') return { text: 'hello world' };
  return {};
});
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHubIfConnected: () => ({ request: hubRequest }) },
}));
vi.mock('../../lib/state.ts', () => ({
  connectionState: { value: 'connected', subscribe: () => () => {} },
  systemState: { value: null },
}));
vi.mock('../../lib/voice/voice-transcript-outbox.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  enqueueTranscript: vi.fn(() => true),
  removePendingTranscript: vi.fn(),
}));
vi.mock('../../lib/voice/voice-stream.ts', () => ({
  openVoiceStream: vi.fn(() => ({ push: vi.fn(), close: vi.fn(), finish: vi.fn() })),
}));
vi.mock('../useNeoVoiceSettings.ts', () => ({ useNeoVoiceSettings: () => true }));
vi.mock('../../components/voice/VoiceWaveform.tsx', () => ({
  VoiceWaveform: () => <div>waveform</div>,
}));

beforeEach(() => {
  records.map.clear();
  hubRequest.mockClear();
  rec.isRecording = false;
  rec.isStarting = false;
  rec.durationLimitHit = false;
  rec.sessionId = null;
  rec.ownerId = null;
  rec.start.mockClear();
  rec.stop.mockClear();
  rec.cancel.mockClear();
});
afterEach(cleanup);

describe('NeoVoice unmount with the real recorder hook', () => {
  it('lands the in-progress clip in the session draft when the composer unmounts', async () => {
    const view = render(
      <NeoVoice
        sessionId="neo:club"
        connected
        draftText="typed first"
        onTranscript={vi.fn()}
        onSendVoice={vi.fn(async () => ({ kind: 'accepted' }) as const)}
        onError={vi.fn()}
        onPhase={vi.fn()}
        onSendHandle={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() => expect(rec.isRecording).toBe(true));

    view.unmount();

    await waitFor(() =>
      expect(hubRequest).toHaveBeenCalledWith(
        'voice.transcribe',
        expect.objectContaining({ audioBase64: 'cmVj' }),
        expect.anything()
      )
    );
    await waitFor(() =>
      expect(hubRequest).toHaveBeenCalledWith(
        'session.appendVoiceDraft',
        expect.objectContaining({ sessionId: 'neo:club', text: 'hello world' })
      )
    );
    expect(rec.stop).toHaveBeenCalledOnce();
    expect(rec.cancel).not.toHaveBeenCalled();
    expect(records.map.size).toBe(0);
  });

  it('uses the current session when a recording starts after a session switch', async () => {
    const props = {
      connected: true,
      draftText: 'typed first',
      onTranscript: vi.fn(),
      onSendVoice: vi.fn(async () => ({ kind: 'accepted' }) as const),
      onError: vi.fn(),
      onPhase: vi.fn(),
      onSendHandle: vi.fn(),
    };
    const view = render(<NeoVoice sessionId="neo:first" {...props} />);
    view.rerender(<NeoVoice sessionId="neo:second" {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() => expect(rec.isRecording).toBe(true));
    expect(rec.sessionId).toBe('neo:second');

    view.unmount();

    await waitFor(() =>
      expect(hubRequest).toHaveBeenCalledWith(
        'session.appendVoiceDraft',
        expect.objectContaining({ sessionId: 'neo:second', text: 'hello world' })
      )
    );
    expect(rec.stop).toHaveBeenCalledOnce();
  });
});
