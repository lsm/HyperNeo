import { renderHook } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type EventRecord = {
  method: string;
  handler: (data: unknown, context?: { channel?: string }) => void;
};

const hubRequest = vi.fn();
const handlers: EventRecord[] = [];

function onEvent(method: string, handler: (data: unknown, context?: { channel?: string }) => void) {
  handlers.push({ method, handler });
  return () => {
    const index = handlers.findIndex((entry) => entry.handler === handler);
    if (index >= 0) handlers.splice(index, 1);
  };
}

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: vi.fn(() => ({ request: hubRequest, onEvent })),
  },
}));

import { connectionState } from '../../lib/state.ts';
import { useNeoVoiceRecovery } from '../useNeoVoiceRecovery.ts';

function emit(method: string, channel: string): void {
  for (const entry of handlers.filter((item) => item.method === method)) {
    entry.handler({ sessionId: channel }, { channel });
  }
}

describe('useNeoVoiceRecovery', () => {
  beforeEach(() => {
    handlers.length = 0;
    hubRequest.mockReset();
    connectionState.value = 'disconnected';
  });

  afterEach(() => {
    connectionState.value = 'disconnected';
  });

  function setup(initialDraft = '') {
    const draft = signal(initialDraft);
    const write = vi.fn((text: string) => {
      draft.value = text;
    });
    const view = renderHook(() =>
      useNeoVoiceRecovery(
        'neo-1',
        () => draft.value,
        (text) => write(text)
      )
    );
    return { draft, write, ...view };
  }

  it('adopts a staged voice transcript into the empty composer exactly once', async () => {
    hubRequest.mockResolvedValue({ session: { metadata: { inputDraft: 'buy oat milk' } } });
    const { write } = setup();

    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('buy oat milk'));
    expect(write).toHaveBeenCalledTimes(1);

    emit('session.voiceLanded', 'session:neo-1');
    emit('session.voiceLanded', 'session:neo-1');
    connectionState.value = 'connected';
    await vi.waitFor(() => expect(hubRequest.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('never sends: the transcript lands as an editable draft value only', async () => {
    hubRequest.mockResolvedValue({ session: { metadata: { inputDraft: 'buy oat milk' } } });
    const { draft, write } = setup();

    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(draft.value).toBe('buy oat milk');
    const sent = hubRequest.mock.calls.some(([method]) => String(method).includes('send'));
    expect(sent).toBe(false);
  });

  it('ignores voiceLanded events from other sessions', async () => {
    hubRequest.mockResolvedValue({ session: { metadata: { inputDraft: '' } } });
    const { write } = setup();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(write).not.toHaveBeenCalled();

    hubRequest.mockResolvedValue({ session: { metadata: { inputDraft: 'other text' } } });
    emit('session.voiceLanded', 'session:not-mine');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(write).not.toHaveBeenCalled();

    hubRequest.mockResolvedValue({ session: { metadata: { inputDraft: 'buy oat milk' } } });
    emit('session.voiceLanded', 'session:neo-1');
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('buy oat milk'));
  });

  it('does not overwrite a draft the user is typing and adopts once the composer is free', async () => {
    hubRequest.mockResolvedValue({ session: { metadata: { inputDraft: 'buy oat milk' } } });
    const { draft, write } = setup('do not clobber this');

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(write).not.toHaveBeenCalled();
    expect(draft.value).toBe('do not clobber this');

    draft.value = '';
    emit('session.voiceLanded', 'session:neo-1');
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('buy oat milk'));
  });

  it('does not resurrect text after the user cleared an adopted draft', async () => {
    hubRequest.mockResolvedValue({ session: { metadata: { inputDraft: 'buy oat milk' } } });
    const { draft, write } = setup();

    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    draft.value = '';
    emit('session.voiceLanded', 'session:neo-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft untouched while offline and adopts after reconnect', async () => {
    const { connectionManager } = await import('../../lib/connection-manager');
    let online = false;
    vi.mocked(connectionManager.getHubIfConnected).mockImplementation(() =>
      online ? ({ request: hubRequest, onEvent } as never) : null
    );
    hubRequest.mockResolvedValue({ session: { metadata: { inputDraft: 'buy oat milk' } } });
    const { write } = setup();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(write).not.toHaveBeenCalled();

    online = true;
    connectionState.value = 'connected';
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('buy oat milk'));
    vi.mocked(connectionManager.getHubIfConnected).mockImplementation(
      () => ({ request: hubRequest, onEvent }) as never
    );
  });
});
