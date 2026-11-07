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
      await live.finish();
      expect(request).toHaveBeenCalledWith('voice.stream.start', {
        encoding: 'pcm16',
        sampleRate: 16_000,
        ...(value === 'auto' ? {} : { language: value }),
      });
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

describe('VoiceSettings mode', () => {
  beforeEach(() => vi.mocked(updateGlobalSettings).mockReset());

  it('exposes Auto in closed Advanced without writing, and refuses streaming without a route', () => {
    render(<VoiceSettings />);
    const advanced = screen.getByText('Advanced').closest('details');
    expect(advanced?.open).toBe(false);
    const mode = screen.getByLabelText('Voice mode') as HTMLSelectElement;
    expect(mode.value).toBe('auto');
    expect((mode.querySelector('option[value="streaming"]') as HTMLOptionElement).disabled).toBe(
      true
    );
    fireEvent.change(mode, { target: { value: 'streaming' } });
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it('preserves a saved streaming value without a live route and describes the fallback', () => {
    globalSettings.value = {
      voice: {
        enabled: true,
        endpoint: 'https://example.test/batch',
        model: 'fixture',
        mode: 'streaming',
      },
    } as GlobalSettings;
    render(<VoiceSettings />);
    expect((screen.getByLabelText('Voice mode') as HTMLSelectElement).value).toBe('streaming');
    expect(screen.getByText(/saved streaming mode.*batch/i)).toBeTruthy();
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it.each([
    { streamEndpoint: 'https://example.test/live', streamProtocol: 'deepgram' },
    { streamEndpoint: 'not a URL', streamProtocol: 'deepgram' },
    { streamEndpoint: 'wss://example.test/live', streamProtocol: 'openai-realtime' },
  ] as const)('does not offer streaming for unsupported routes: $streamEndpoint', (route) => {
    globalSettings.value = {
      voice: { enabled: true, endpoint: 'https://example.test/batch', model: 'fixture', ...route },
    } as GlobalSettings;
    render(<VoiceSettings />);
    const option = screen.getByRole('option', {
      name: /Streaming/,
      hidden: true,
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it('saves streaming when a supported live endpoint exists', async () => {
    globalSettings.value = {
      voice: {
        enabled: true,
        endpoint: 'https://example.test/batch',
        model: 'fixture',
        streamEndpoint: 'wss://example.test/live',
        streamProtocol: 'deepgram',
      },
    } as GlobalSettings;
    vi.mocked(updateGlobalSettings).mockResolvedValue({
      success: true,
      settings: {} as GlobalSettings,
    });
    render(<VoiceSettings />);
    const mode = screen.getByLabelText('Voice mode') as HTMLSelectElement;
    expect((mode.querySelector('option[value="streaming"]') as HTMLOptionElement).disabled).toBe(
      false
    );
    fireEvent.change(mode, { target: { value: 'streaming' } });
    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenCalledWith(
        {
          voice: expect.objectContaining({
            mode: 'streaming',
            streamEndpoint: 'wss://example.test/live',
          }),
        },
        { timeout: 120_000 }
      )
    );
  });
});
