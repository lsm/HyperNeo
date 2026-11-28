import { act, cleanup, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceDraftPreview } from '../VoiceDraftPreview.tsx';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const heard = () => screen.queryByTestId('voice-interim-text')?.textContent ?? '';

function live(interim: string, transcribing = false) {
  return (
    <VoiceDraftPreview text="" start={0} end={0} transcribing={transcribing} interim={interim} />
  );
}

function wait(ms: number) {
  for (let passed = 0; passed < ms; passed += 5)
    act(() => {
      vi.advanceTimersByTime(5);
    });
}

describe('VoiceDraftPreview', () => {
  it('shows interim speech grey after the draft in place of the hint', () => {
    render(
      <VoiceDraftPreview
        text="typed"
        start={5}
        end={5}
        transcribing={false}
        interim="hello ne"
        newLine
        hint="Listening…"
      />
    );
    wait(1000);
    const interim = screen.getByTestId('voice-interim-text');
    expect(interim.textContent).toBe('hello ne');
    expect(interim.className).toContain('text-fg-muted');
    expect(screen.getByTestId('voice-recording-draft').textContent).toBe('typed\nhello ne');
  });

  it('keeps the listening hint when nothing has been heard yet', () => {
    render(<VoiceDraftPreview text="" start={0} end={0} transcribing={false} hint="Listening…" />);
    expect(screen.queryByTestId('voice-interim-text')).toBeNull();
    expect(screen.getByText('Listening…')).toBeTruthy();
  });

  it('types a burst of speech out at a steady pace', () => {
    render(live('hello there'));
    expect(heard()).toBe('');
    wait(25);
    expect(heard()).toBe('h');
    wait(100);
    expect(heard()).toBe('hello');
    wait(1000);
    expect(heard()).toBe('hello there');
  });

  it('catches up on a long burst instead of lagging far behind', () => {
    render(live('a'.repeat(400)));
    wait(600);
    expect(heard().length).toBeGreaterThan(200);
    wait(2400);
    expect(heard().length).toBe(400);
  });

  it('shows slow speech as it arrives and nothing more without new text', () => {
    const view = render(live('hi'));
    wait(1000);
    expect(heard()).toBe('hi');
    view.rerender(live('hi y'));
    wait(50);
    expect(heard()).toBe('hi y');
    wait(1000);
    expect(heard()).toBe('hi y');
  });

  it('keeps the shared start when the recognizer revises earlier words', () => {
    const view = render(live('I scream'));
    wait(1000);
    view.rerender(live('Ice cream'));
    expect(heard()).toBe('I');
    wait(1000);
    expect(heard()).toBe('Ice cream');
  });

  it('shows the whole utterance at once when it ends', () => {
    const view = render(live('one two three four'));
    wait(25);
    view.rerender(live('one two three four', true));
    expect(heard()).toBe('one two three four');
  });
});
