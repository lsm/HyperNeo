import type { GlobalSettings } from '@hyperneo/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateGlobalSettings } from '../../../lib/api-helpers.ts';
import { VoiceSettings } from '../VoiceSettings.tsx';

const { globalSettings } = vi.hoisted(() => ({
  globalSettings: { value: undefined as GlobalSettings | undefined },
}));
vi.mock('../../../lib/state.ts', () => ({ globalSettings }));
vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings: vi.fn() }));
vi.mock('../../../lib/connection-manager.ts', () => ({ connectionManager: {} }));

beforeEach(() => {
  globalSettings.value = {
    voice: {
      enabled: true,
      endpoint: 'https://api.openai.com/v1/audio/transcriptions',
      model: 'whisper-1',
      streamEndpoint: 'wss://api.deepgram.com/v1/listen',
      speech: {
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1/audio/speech',
        model: 'tts',
        voice: 'alloy',
      },
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

describe('VoiceSettings providers', () => {
  it('shows each provider and speech setting without a live model', () => {
    render(<VoiceSettings />);
    expect((screen.getByLabelText('Recorded provider') as HTMLSelectElement).value).toBe('openai');
    expect((screen.getByLabelText('Live provider') as HTMLSelectElement).value).toBe('deepgram');
    expect((screen.getByLabelText('Speech provider') as HTMLSelectElement).value).toBe('openai');
    expect((screen.getByLabelText('Speech endpoint') as HTMLInputElement).value).toContain(
      '/audio/speech'
    );
    expect((screen.getByLabelText('Speech model') as HTMLInputElement).value).toBe('tts');
    expect((screen.getByLabelText('Speech voice') as HTMLInputElement).value).toBe('alloy');
    expect(screen.queryByLabelText('Live model')).toBeNull();
  });

  it('places the recorded model between the batch endpoint and live provider', () => {
    render(<VoiceSettings />);
    const batch = screen.getByLabelText('Batch endpoint');
    const model = screen.getByLabelText('Recorded model');
    const live = screen.getByLabelText('Live provider');
    expect(batch.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(model.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not configure speech when an empty field is left unchanged', () => {
    globalSettings.value = { voice: { enabled: true, endpoint: '', model: '' } } as GlobalSettings;
    render(<VoiceSettings />);
    fireEvent.focus(screen.getByLabelText('Speech endpoint'));
    fireEvent.blur(screen.getByLabelText('Speech endpoint'));
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it('persists provider and speech edits through voice settings', async () => {
    render(<VoiceSettings />);
    fireEvent.change(screen.getByLabelText('Recorded provider'), { target: { value: 'deepgram' } });
    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenCalledWith(
        {
          voice: expect.objectContaining({
            recorded: expect.objectContaining({ provider: 'deepgram' }),
          }),
        },
        { timeout: 120_000 }
      )
    );
    const voice = screen.getByLabelText('Speech voice');
    fireEvent.input(voice, { target: { value: 'nova' } });
    fireEvent.blur(voice);
    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenLastCalledWith(
        { voice: expect.objectContaining({ speech: expect.objectContaining({ voice: 'nova' }) }) },
        { timeout: 120_000 }
      )
    );
  });
});
