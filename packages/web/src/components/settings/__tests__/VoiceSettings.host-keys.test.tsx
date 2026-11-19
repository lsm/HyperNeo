import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalSettings } from '@hyperneo/shared';
import { updateGlobalSettings } from '../../../lib/api-helpers.ts';
import { toastsSignal } from '../../../lib/toast.ts';
import { VoiceSettings } from '../VoiceSettings.tsx';

const { globalSettings } = vi.hoisted(() => ({
  globalSettings: { value: undefined as GlobalSettings | undefined },
}));
vi.mock('../../../lib/state.ts', () => ({ globalSettings }));
vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings: vi.fn() }));
vi.mock('../../../lib/connection-manager.ts', () => ({ connectionManager: {} }));

beforeEach(() => {
  toastsSignal.value = [];
  globalSettings.value = {
    voice: {
      enabled: true,
      endpoint: 'https://api.openai.com/v1/audio/transcriptions',
      model: 'whisper-1',
      streamEndpoint: 'wss://api.deepgram.com/v1/listen',
      speech: { provider: 'openai', endpoint: 'https://api.openai.com/v1/audio/speech' },
      hasApiKey: true,
      apiKeyEndpoint: 'https://api.openai.com/v1/audio/transcriptions',
    },
  } as GlobalSettings;
  vi.mocked(updateGlobalSettings)
    .mockReset()
    .mockResolvedValue({ success: true, settings: {} as GlobalSettings });
});
afterEach(() => {
  cleanup();
  globalSettings.value = undefined;
});

describe('VoiceSettings host keys', () => {
  it('shows one empty password field per secure host and preserves the legacy key control', () => {
    render(<VoiceSettings />);
    const openai = screen.getByLabelText('API key for api.openai.com') as HTMLInputElement;
    const deepgram = screen.getByLabelText('API key for api.deepgram.com') as HTMLInputElement;
    expect(openai.type).toBe('password');
    expect(deepgram.type).toBe('password');
    expect(openai.value).toBe('');
    expect(screen.getAllByLabelText('API key for api.openai.com')).toHaveLength(1);
    expect(screen.getByText('Key saved. Enter a new key to replace it.')).toBeTruthy();
  });

  it('saves and removes a key using that host and clears the input', async () => {
    render(<VoiceSettings />);
    const deepgram = screen.getByLabelText('API key for api.deepgram.com') as HTMLInputElement;
    fireEvent.input(deepgram, { target: { value: 'synthetic-deepgram' } });
    fireEvent.blur(deepgram);
    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenCalledWith(
        {
          voice: expect.objectContaining({
            hostKey: { host: 'api.deepgram.com', apiKey: 'synthetic-deepgram' },
          }),
        },
        { timeout: 120_000 }
      )
    );
    expect(deepgram.value).toBe('');
    await waitFor(() =>
      expect(
        toastsSignal.value.some((toast) => toast.message === 'Key saved for api.deepgram.com')
      ).toBe(true)
    );
    expect(JSON.stringify(toastsSignal.value)).not.toContain('synthetic-deepgram');
    fireEvent.click(screen.getByLabelText('Remove API key for api.deepgram.com'));
    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenLastCalledWith(
        { voice: expect.objectContaining({ hostKey: { host: 'api.deepgram.com' } }) },
        { timeout: 120_000 }
      )
    );
    await waitFor(() =>
      expect(
        toastsSignal.value.some((toast) => toast.message === 'Key removed for api.deepgram.com')
      ).toBe(true)
    );
  });

  it('does not report success when saving a key fails', async () => {
    vi.mocked(updateGlobalSettings).mockRejectedValueOnce(new Error('save failed'));
    render(<VoiceSettings />);
    const key = screen.getByLabelText('API key for api.deepgram.com');
    fireEvent.input(key, { target: { value: 'synthetic-deepgram' } });
    fireEvent.blur(key);
    await waitFor(() =>
      expect(toastsSignal.value.some((toast) => toast.message === 'save failed')).toBe(true)
    );
    expect(toastsSignal.value.some((toast) => toast.type === 'success')).toBe(false);
  });

  it('follows structured part endpoints and omits insecure endpoints', () => {
    globalSettings.value = {
      voice: {
        enabled: true,
        endpoint: 'https://stale.example/v1',
        model: 'whisper-1',
        recorded: { provider: 'openai', endpoint: 'http://local.example/v1', model: 'whisper-1' },
        live: { provider: 'deepgram', endpoint: 'wss://live.example/v1' },
        speech: { provider: 'openai', endpoint: 'https://speech.example/v1' },
      },
    } as GlobalSettings;
    render(<VoiceSettings />);
    expect(screen.queryByLabelText('API key for stale.example')).toBeNull();
    expect(screen.queryByLabelText('API key for local.example')).toBeNull();
    expect(screen.getByLabelText('API key for live.example')).toBeTruthy();
    expect(screen.getByLabelText('API key for speech.example')).toBeTruthy();
  });
});
