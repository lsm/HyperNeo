import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoRealtimeVoice } from '../NeoRealtimeVoice.tsx';

const mocks = vi.hoisted(() => ({
  catalog: { ok: true } as { ok: boolean; reason?: string },
  request: vi.fn(),
  players: [] as { sessionId: string; close: ReturnType<typeof vi.fn> }[],
}));

vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHubIfConnected: () => ({ request: mocks.request }) },
}));
vi.mock('../../lib/voice/neo-speech-player.ts', () => ({
  openNeoSpeechPlayer: (_hub: unknown, sessionId: string) => {
    const player = { sessionId, close: vi.fn(), interrupt: vi.fn() };
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
