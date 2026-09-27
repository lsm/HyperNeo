import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsState } from '@hyperneo/shared';
import { useNeoVoiceSettings } from '../useNeoVoiceSettings.ts';

const hub = vi.hoisted(() => ({ request: vi.fn(), onEvent: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHubIfConnected: () => hub },
}));
vi.mock('../../lib/state.ts', () => ({ connectionState: { value: 'connected' } }));
function VoiceAvailability() {
  return <p>{useNeoVoiceSettings() ? 'Ready' : 'Not configured'}</p>;
}
beforeEach(() => {
  vi.clearAllMocks();
  hub.onEvent.mockReturnValue(hub.unsubscribe);
});
afterEach(cleanup);

describe('Neo voice settings', () => {
  it.each([
    [true, 'https://voice.example/v1', 'transcribe', 'Ready'],
    [false, 'https://voice.example/v1', 'transcribe', 'Not configured'],
    [true, '', 'transcribe', 'Not configured'],
    [true, 'https://voice.example/v1', '', 'Not configured'],
    [true, 'file:///voice', 'transcribe', 'Not configured'],
  ])('checks enabled=%s endpoint=%s model=%s', async (enabled, endpoint, model, expected) => {
    hub.request.mockResolvedValue({
      settings: { settings: { voice: { enabled, endpoint, model } } },
    });
    const view = render(<VoiceAvailability />);
    await act(async () => {});
    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
    view.unmount();
    expect(hub.unsubscribe).toHaveBeenCalled();
  });
  it('does not let a stale snapshot overwrite a newer settings event', async () => {
    let resolve: (value: unknown) => void = () => {};
    hub.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    render(<VoiceAvailability />);
    const update = hub.onEvent.mock.calls[0][1] as (state: SettingsState) => void;
    update({
      settings: {
        voice: { enabled: true, endpoint: 'https://voice.example', model: 'transcribe' },
      },
    } as SettingsState);
    resolve({ settings: { settings: { voice: { enabled: false } } } });
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy());
  });
});
