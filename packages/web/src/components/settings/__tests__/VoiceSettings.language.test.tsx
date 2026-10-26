import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import { VoiceSettings } from '../VoiceSettings.tsx';
import { openVoiceStream } from '../../../lib/voice/voice-stream.ts';

vi.mock('../../../lib/state.ts', () => ({ globalSettings: { value: undefined } }));
vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings: vi.fn() }));
vi.mock('../../../lib/connection-manager.ts', () => ({ connectionManager: {} }));

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.mocked(localStorage.getItem).mockImplementation((key) => stored.get(key) ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
    stored.set(key, value);
  });
});
afterEach(cleanup);

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
