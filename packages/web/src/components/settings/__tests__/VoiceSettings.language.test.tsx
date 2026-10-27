import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalSettings, MessageHub } from '@hyperneo/shared';
import { updateGlobalSettings } from '../../../lib/api-helpers.ts';
import { VoiceSettings } from '../VoiceSettings.tsx';
import { openVoiceStream } from '../../../lib/voice/voice-stream.ts';

const { globalSettings } = vi.hoisted(() => ({
  globalSettings: { value: undefined as GlobalSettings | undefined },
}));
vi.mock('../../../lib/state.ts', () => ({ globalSettings }));
vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings: vi.fn() }));
vi.mock('../../../lib/connection-manager.ts', () => ({ connectionManager: {} }));

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.mocked(localStorage.getItem).mockImplementation((key) => stored.get(key) ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
    stored.set(key, value);
  });
});
afterEach(() => {
  cleanup();
  globalSettings.value = undefined;
});

describe('VoiceSettings language selector', () => {
  it('defaults to Auto and preserves each user choice across remounts and stream starts', async () => {
    const request = vi.fn(async () => ({ streamId: 'stub', via: 'streaming', text: 'heard' }));
    const hub = { request, onEvent: () => () => {} } as unknown as MessageHub;
    let view = render(<VoiceSettings />);
    expect(
      screen.getByText(
        'Saved in this browser. Applies to the next live ASR connection only, excluding batch transcription and fallback. Auto keeps server defaults.'
      )
    ).toBeTruthy();
    expect((screen.getByLabelText('Live transcription language') as HTMLSelectElement).value).toBe(
      'auto'
    );
    for (const [value, label] of [
      ['zh', '中文'],
      ['en', 'English'],
      ['auto', 'Auto'],
    ]) {
      const select = screen.getByLabelText('Live transcription language') as HTMLSelectElement;
      fireEvent.change(select, { target: { value } });
      expect(select.selectedOptions[0].textContent).toBe(label);
      view.unmount();
      view = render(<VoiceSettings />);
      expect(
        (screen.getByLabelText('Live transcription language') as HTMLSelectElement).value
      ).toBe(value);
      const live = openVoiceStream(hub, vi.fn());
      expect(request).toHaveBeenCalledWith('voice.stream.start', {
        encoding: 'pcm16',
        sampleRate: 16_000,
        ...(value === 'auto' ? {} : { language: value }),
      });
      await live.finish();
      live.close();
    }
  });
});

describe('VoiceSettings endpoint fields', () => {
  it('saves independent batch and live URLs and allows clearing the live URL', async () => {
    vi.mocked(updateGlobalSettings).mockResolvedValue({
      success: true,
      settings: {} as GlobalSettings,
    });
    const view = render(<VoiceSettings />);
    const batch = screen.getByLabelText('Batch endpoint') as HTMLInputElement;
    const live = screen.getByLabelText('Live endpoint') as HTMLInputElement;
    fireEvent.input(batch, { target: { value: 'https://h/custom/transcribe?x=1' } });
    fireEvent.blur(batch);
    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenLastCalledWith(
        { voice: expect.objectContaining({ endpoint: 'https://h/custom/transcribe?x=1' }) },
        { timeout: 120_000 }
      )
    );
    fireEvent.input(live, { target: { value: 'wss://other/live?language=zh' } });
    fireEvent.blur(live);
    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenLastCalledWith(
        {
          voice: expect.objectContaining({
            endpoint: 'https://h/custom/transcribe?x=1',
            streamEndpoint: 'wss://other/live?language=zh',
          }),
        },
        { timeout: 120_000 }
      )
    );
    view.unmount();
    globalSettings.value = {
      voice: {
        enabled: true,
        endpoint: 'https://h/custom/transcribe?x=1',
        model: 'stub',
        streamEndpoint: 'wss://other/live?language=zh',
      },
    } as GlobalSettings;
    render(<VoiceSettings />);
    const savedLive = screen.getByLabelText('Live endpoint');
    fireEvent.input(savedLive, { target: { value: '' } });
    fireEvent.blur(savedLive);
    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenLastCalledWith(
        { voice: expect.objectContaining({ streamEndpoint: '' }) },
        { timeout: 120_000 }
      )
    );
  });
});
