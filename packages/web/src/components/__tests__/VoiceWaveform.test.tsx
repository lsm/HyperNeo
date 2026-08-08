import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceWaveform } from '../voice/VoiceWaveform.tsx';

beforeEach(() => {
  // Default: no-op rAF so the meter loop never schedules (structural tests).
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
});

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
    // X is the first control in the row, before the bars.
    const panel = screen.getByTestId('voice-recording-panel');
    expect(panel.firstElementChild).toBe(cancel);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('drives the bar meters from getLevel via requestAnimationFrame', () => {
    // Restore a real rAF, then fake the clock so we can advance frames deterministically.
    vi.unstubAllGlobals();
    vi.useFakeTimers();
    render(
      <VoiceWaveform
        getLevel={() => 0.9}
        isRecording={true}
        isTranscribing={false}
        onCancel={() => {}}
      />
    );
    // ~30 frames: a new column is pushed every 3rd frame.
    vi.advanceTimersByTime(500);

    const row = screen.getByTestId('voice-bars');
    const bars = [...row.children] as HTMLElement[];
    expect(bars.length).toBe(72);
    const scales = [...bars].map((b) => {
      const match = (b as HTMLElement).style.transform.match(/scaleY\(([\d.]+)\)/);
      return match ? Number.parseFloat(match[1]) : 0;
    });
    // Spoken-level samples (0.9) must push at least one bar well above the floor.
    expect(Math.max(...scales)).toBeGreaterThan(0.5);
  });
});
