import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoRealtimeVoice } from '../NeoRealtimeVoice.tsx';

const mocks = vi.hoisted(() => ({
  catalog: { ok: true } as { ok: boolean; reason?: string },
  request: vi.fn(),
  players: [] as { sessionId: string; close: ReturnType<typeof vi.fn>; onStop?: () => void }[],
}));

vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHubIfConnected: () => ({ request: mocks.request }) },
}));
vi.mock('../../lib/voice/neo-speech-player.ts', () => ({
  openNeoSpeechPlayer: (
    _hub: unknown,
    sessionId: string,
    options: { onStop?: () => void } = {}
  ) => {
    const player = { sessionId, close: vi.fn(), interrupt: vi.fn(), onStop: options.onStop };
    mocks.players.push(player);
    return player;
  },
}));

const listens = () =>
  mocks.request.mock.calls
    .map((call) => call[1] as { name: string; input: Record<string, unknown> })
    .filter((call) => call.name === 'neo.speech.listen')
    .map((call) => call.input);
const button = () => screen.getByRole('button');

beforeEach(() => {
  mocks.catalog = { ok: true };
  mocks.players = [];
  mocks.request.mockReset();
  mocks.request.mockImplementation(async (_method: string, data: { name: string }) =>
    data.name === 'neo.speech.catalog' ? mocks.catalog : { ok: true }
  );
});
afterEach(cleanup);

describe('NeoRealtimeVoice', () => {
  it('starts listening with audio and plays Neo for this session', async () => {
    render(<NeoRealtimeVoice collapsed={false} sessionId="neo-1" connected onError={vi.fn()} />);
    expect(button().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button());
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'));
    expect(listens()).toEqual([{ sessionId: 'neo-1', enabled: true, audio: true }]);
    expect(mocks.players.map((player) => player.sessionId)).toEqual(['neo-1']);
    expect(button().getAttribute('aria-label')).toBe('Stop realtime voice');
  });

  it('stops listening and releases the player when pressed again', async () => {
    render(<NeoRealtimeVoice collapsed={false} sessionId="neo-1" connected onError={vi.fn()} />);
    fireEvent.click(button());
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(button());
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('false'));
    expect(listens().at(-1)).toEqual({ sessionId: 'neo-1', enabled: false });
    expect(mocks.players[0].close).toHaveBeenCalled();
  });

  it('says so and stays off when the daemon has no speech backend', async () => {
    mocks.catalog = { ok: false, reason: 'speech_backend_not_configured' };
    const onError = vi.fn();
    render(<NeoRealtimeVoice collapsed={false} sessionId="neo-1" connected onError={onError} />);
    fireEvent.click(button());
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Voice replies are not set up on this daemon.')
    );
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(listens()).toEqual([]);
    expect(mocks.players[0].close).toHaveBeenCalled();
  });

  it('turns off when another device takes over listening', async () => {
    render(<NeoRealtimeVoice collapsed={false} sessionId="neo-1" connected onError={vi.fn()} />);
    fireEvent.click(button());
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'));
    mocks.players[0].onStop?.();
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('false'));
    expect(mocks.players[0].close).toHaveBeenCalled();
    expect(listens()).toEqual([{ sessionId: 'neo-1', enabled: true, audio: true }]);
  });

  it('ignores the stop from its own earlier disable during a quick restart', async () => {
    render(<NeoRealtimeVoice collapsed={false} sessionId="neo-1" connected onError={vi.fn()} />);
    fireEvent.click(button());
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'));
    let disabled: (value: unknown) => void = () => {};
    let accept: (value: unknown) => void = () => {};
    mocks.request.mockImplementation(
      async (_method: string, data: { name: string; input: { enabled?: boolean } }) =>
        data.name !== 'neo.speech.listen'
          ? { ok: true }
          : new Promise((resolve) => {
              if (data.input.enabled) accept = resolve;
              else disabled = resolve;
            })
    );
    fireEvent.click(button());
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('false'));
    fireEvent.click(button());
    await waitFor(() => expect(listens()).toHaveLength(3));
    mocks.players[1].onStop?.();
    disabled({ ok: true });
    accept({ ok: true });
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'));
    expect(mocks.players[1].close).not.toHaveBeenCalled();
  });

  it('turns off when another device takes over before its start is answered', async () => {
    let accept: (value: unknown) => void = () => {};
    mocks.request.mockImplementation(
      async (_method: string, data: { name: string; input: { enabled?: boolean } }) =>
        data.name === 'neo.speech.listen' && data.input.enabled
          ? new Promise((resolve) => {
              accept = resolve;
            })
          : { ok: true }
    );
    render(<NeoRealtimeVoice collapsed={false} sessionId="neo-1" connected onError={vi.fn()} />);
    fireEvent.click(button());
    await waitFor(() => expect(listens()).toHaveLength(1));
    mocks.players[0].onStop?.();
    accept({ ok: true });
    await new Promise((done) => setTimeout(done, 0));
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(mocks.players[0].close).toHaveBeenCalled();
    expect(listens()).toHaveLength(1);
  });

  it('leaves the daemon not listening when stopped during a start that succeeds', async () => {
    let accept: (value: unknown) => void = () => {};
    mocks.request.mockImplementation(
      async (_method: string, data: { name: string; input: { enabled?: boolean } }) =>
        data.name === 'neo.speech.listen' && data.input.enabled
          ? new Promise((resolve) => {
              accept = resolve;
            })
          : { ok: true }
    );
    const onError = vi.fn();
    render(<NeoRealtimeVoice collapsed={false} sessionId="neo-1" connected onError={onError} />);
    fireEvent.click(button());
    await waitFor(() => expect(listens()).toHaveLength(1));
    fireEvent.click(button());
    accept({ ok: true });
    await new Promise((done) => setTimeout(done, 0));
    expect(listens()).toEqual([
      { sessionId: 'neo-1', enabled: true, audio: true },
      { sessionId: 'neo-1', enabled: false },
    ]);
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(mocks.players[0].close).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('shows no notice when a refused start was already stopped', async () => {
    let refuse: (value: unknown) => void = () => {};
    mocks.request.mockImplementation(
      async (_method: string, data: { name: string; input: { enabled?: boolean } }) =>
        data.name === 'neo.speech.catalog'
          ? { ok: true }
          : data.name === 'neo.speech.listen' && data.input.enabled
            ? new Promise((resolve) => {
                refuse = resolve;
              })
            : { ok: true }
    );
    const onError = vi.fn();
    render(<NeoRealtimeVoice collapsed={false} sessionId="neo-1" connected onError={onError} />);
    fireEvent.click(button());
    await waitFor(() => expect(listens()).toHaveLength(1));
    fireEvent.click(button());
    refuse({ ok: false, reason: 'updating' });
    await waitFor(() => expect(listens().at(-1)).toEqual({ sessionId: 'neo-1', enabled: false }));
    await new Promise((done) => setTimeout(done, 0));
    expect(onError).not.toHaveBeenCalled();
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  it('turns off when the connection drops', async () => {
    const view = render(
      <NeoRealtimeVoice collapsed={false} sessionId="neo-1" connected onError={vi.fn()} />
    );
    fireEvent.click(button());
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'));
    view.rerender(
      <NeoRealtimeVoice collapsed={false} sessionId="neo-1" connected={false} onError={vi.fn()} />
    );
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('false'));
    expect(mocks.players[0].close).toHaveBeenCalled();
  });

  it('stops listening when the composer goes away', async () => {
    const view = render(
      <NeoRealtimeVoice collapsed={false} sessionId="neo-1" connected onError={vi.fn()} />
    );
    fireEvent.click(button());
    await waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'));
    view.unmount();
    expect(listens().at(-1)).toEqual({ sessionId: 'neo-1', enabled: false });
    expect(mocks.players[0].close).toHaveBeenCalled();
  });
});
