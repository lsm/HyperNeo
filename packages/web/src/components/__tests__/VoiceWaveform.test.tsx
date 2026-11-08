import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceWaveform } from '../voice/VoiceWaveform.tsx';
import { applyLanguage } from '../../lib/i18n/index.ts';

beforeEach(() => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 0)
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => {
  cleanup();
  applyLanguage('en');
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

function stubClientWidth(px: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => px,
  });
}

describe('VoiceWaveform', () => {
  it('keeps waveform bars and inline progress in the classic composer', () => {
    render(
      <VoiceWaveform
        getLevel={() => 0}
        isRecording={false}
        isTranscribing={true}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId('voice-bars')).toBeTruthy();
    expect(screen.getByTestId('voice-transcribing').querySelector('.animate-spin')).toBeTruthy();
  });

  it.each([undefined, 'neo'] as const)('localizes Chinese transcription for %s', (appearance) => {
    applyLanguage('zh-Hans');
    render(
      <VoiceWaveform
        appearance={appearance}
        getLevel={() => 0}
        isRecording={false}
        isTranscribing={true}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId('voice-transcribing').textContent).toBe('正在转写…');
  });

  it('counts down the four-minute limit in the classic composer', () => {
    render(
      <VoiceWaveform
        getLevel={() => 0}
        isRecording={true}
        isTranscribing={false}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId('voice-recording-panel')).toBeTruthy();
    expect(screen.getByTestId('voice-timer').textContent).toBe('4:00');
  });

  it('counts Neo dictation up from zero using elapsed time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    render(
      <VoiceWaveform
        appearance="neo"
        getLevel={() => 0}
        isRecording={true}
        isTranscribing={false}
        startedAt={Date.now()}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId('voice-timer').textContent).toBe('0:00');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000);
    });
    expect(screen.getByTestId('voice-timer').textContent).toBe('1:15');
  });

  it('shows the transcribing state instead of the timer while transcribing', () => {
    render(
      <VoiceWaveform
        appearance="neo"
        getLevel={() => 0}
        isRecording={false}
        isTranscribing={true}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId('voice-transcribing')).toBeTruthy();
    expect(screen.getByTestId('voice-transcribing').textContent).toBe('Transcribing…');
    expect(screen.queryByTestId('voice-bars')).toBeNull();
    expect(document.querySelector('.animate-spin')).toBeNull();
    expect(screen.queryByTestId('voice-timer')).toBeNull();
  });

  it('discards the recording via the X button at the left end', () => {
    const onCancel = vi.fn();
    render(
      <VoiceWaveform
        getLevel={() => 0}
        isRecording={true}
        isTranscribing={false}
        onCancel={onCancel}
      />
    );
    const cancel = screen.getByLabelText('Cancel recording');
    const panel = screen.getByTestId('voice-recording-panel');
    expect(panel.firstElementChild).toBe(cancel);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('derives the column count from the row width on narrow viewports', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    stubClientWidth(160);
    render(
      <VoiceWaveform
        getLevel={() => 0}
        isRecording={true}
        isTranscribing={false}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId('voice-bars').children.length).toBe(40);
  });

  it('drives the bar meters from getLevel via requestAnimationFrame', () => {
    vi.unstubAllGlobals();
    stubClientWidth(600);
    vi.useFakeTimers();
    render(
      <VoiceWaveform
        getLevel={() => 0.9}
        isRecording={true}
        isTranscribing={false}
        onCancel={() => {}}
      />
    );
    vi.advanceTimersByTime(500);

    const row = screen.getByTestId('voice-bars');
    const bars = [...row.children] as HTMLElement[];
    expect(bars.length).toBe(120);
    const scales = [...bars].map((b) => {
      const match = (b as HTMLElement).style.transform.match(/scaleY\(([\d.]+)\)/);
      return match ? Number.parseFloat(match[1]) : 0;
    });
    expect(Math.max(...scales)).toBeGreaterThan(0.5);
  });
});

describe('Voice waveform cadence', () => {
  it.each([30, 60, 120])('keeps microphone sampling time-based at %s Hz', async (hz) => {
    stubClientWidth(200);
    let next: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      next = callback;
      return 1;
    });
    const getLevel = vi.fn(() => 0.5);
    render(
      <VoiceWaveform
        getLevel={getLevel}
        isRecording={true}
        isTranscribing={false}
        onCancel={() => {}}
      />
    );
    await act(async () => {});
    for (let frame = 0; frame <= hz; frame++) {
      const callback = next;
      next = undefined;
      callback?.((frame * 1000) / hz);
    }
    expect(getLevel.mock.calls.length).toBeGreaterThanOrEqual(Math.min(hz, 60) - 1);
    expect(getLevel.mock.calls.length).toBeLessThanOrEqual(62);
    const bars = [...screen.getByTestId('voice-bars').children] as HTMLElement[];
    expect(
      Math.max(...bars.map((bar) => Number(bar.style.transform.slice(7, -1))))
    ).toBeGreaterThan(0.4);
  });
});
