import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceWaveform } from '../voice/VoiceWaveform.tsx';

beforeEach(() => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 0)
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => {
  cleanup();
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
  it('renders the elapsed timer at 0:00 while recording', () => {
    render(
      <VoiceWaveform
        getLevel={() => 0}
        isRecording={true}
        isTranscribing={false}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId('voice-recording-panel')).toBeTruthy();
    expect(screen.getByTestId('voice-timer').textContent).toBe('5:00');
  });

  it('shows the transcribing state instead of the timer while transcribing', () => {
    render(
      <VoiceWaveform
        getLevel={() => 0}
        isRecording={false}
        isTranscribing={true}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId('voice-transcribing')).toBeTruthy();
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
