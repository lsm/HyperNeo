import { act, cleanup, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceDraftPreview } from '../VoiceDraftPreview.tsx';

const FRAME_MS = 1000 / 60;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const laidOut = () => screen.queryByTestId('voice-interim-text')?.textContent ?? '';
const pending = () => screen.queryByTestId('voice-interim-pending')?.textContent ?? '';
const shown = () => laidOut().slice(0, laidOut().length - pending().length);
const fresh = () => screen.queryAllByTestId('voice-interim-fresh');

function live(interim: string, transcribing = false) {
  return (
    <VoiceDraftPreview text="" start={0} end={0} transcribing={transcribing} interim={interim} />
  );
}

function frames(count: number) {
  for (let frame = 0; frame < count; frame++)
    act(() => {
      vi.advanceTimersByTime(FRAME_MS);
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
    frames(120);
    const interim = screen.getByTestId('voice-interim-text');
    expect(shown()).toBe('hello ne');
    expect(pending()).toBe('');
    expect(interim.className).toContain('text-fg-muted');
    expect(screen.getByTestId('voice-recording-draft').textContent).toBe('typed\nhello ne');
  });

  it('keeps the listening hint when nothing has been heard yet', () => {
    render(<VoiceDraftPreview text="" start={0} end={0} transcribing={false} hint="Listening…" />);
    expect(screen.queryByTestId('voice-interim-text')).toBeNull();
    expect(screen.getByText('Listening…')).toBeTruthy();
  });

  it('lays the whole text out clear before revealing it', () => {
    render(live('hello there'));
    expect(laidOut()).toBe('hello there');
    expect(shown()).toBe('');
    const rest = screen.getByTestId('voice-interim-pending');
    expect(rest.style.opacity).toBe('0');
    expect(rest.getAttribute('aria-hidden')).toBe('true');
  });

  it('reveals uneven bursts about one character per frame without long stops', () => {
    const words =
      'so the plan for tomorrow is to meet at the station at nine then drive north'.split(' ');
    const bursts = [3, 1, 4, 2, 5, 1];
    const gaps = [55, 20, 70, 35, 60, 40];
    const view = render(live(''));
    const counts: number[] = [];
    let used = 0;
    for (const [i, size] of bursts.entries()) {
      used += size;
      view.rerender(live(words.slice(0, used).join(' ')));
      for (let frame = 0; frame < (gaps[i] ?? 0); frame++) {
        frames(1);
        counts.push(shown().length);
      }
    }
    const target = words.slice(0, used).join(' ').length;
    const steps = counts.slice(1).map((count, i) => count - (counts[i] ?? 0));
    expect(Math.max(...steps)).toBeLessThanOrEqual(2);
    let still = 0;
    let longest = 0;
    for (const [i, step] of steps.entries()) {
      still = step === 0 && (counts[i + 1] ?? 0) < target ? still + 1 : 0;
      longest = Math.max(longest, still);
    }
    expect(longest * FRAME_MS).toBeLessThan(300);
    expect(counts.at(-1)).toBe(target);
  });

  it('trails a long burst by well under a second', () => {
    render(live('a'.repeat(60)));
    frames(30);
    expect(shown().length).toBeGreaterThan(10);
    expect(shown().length).toBeLessThan(60);
    frames(60);
    expect(shown().length).toBe(60);
  });

  it('keeps the shared start when the recognizer revises earlier words', () => {
    const view = render(live('I scream'));
    frames(120);
    view.rerender(live('Ice cream'));
    expect(shown()).toBe('I');
    expect(laidOut()).toBe('Ice cream');
    frames(120);
    expect(shown()).toBe('Ice cream');
  });

  it('shows the whole utterance at once when it ends', () => {
    const view = render(live('one two three four'));
    frames(2);
    view.rerender(live('one two three four', true));
    expect(shown()).toBe('one two three four');
    expect(fresh()).toHaveLength(0);
  });

  it('fades each new character in from clear to solid behind the cursor', () => {
    render(live('a'.repeat(40)));
    frames(20);
    const levels = fresh().map((char) => Number(char.style.opacity));
    expect(levels.length).toBeGreaterThan(1);
    for (const level of levels) expect(level).toBeGreaterThan(0);
    for (const level of levels) expect(level).toBeLessThan(1);
    expect(levels[0]).toBeGreaterThan(levels.at(-1) ?? 1);
    frames(120);
    expect(shown()).toBe('a'.repeat(40));
    expect(fresh()).toHaveLength(0);
  });

  it('fades in the first characters of a burst that follows a pause', () => {
    const first = 'a'.repeat(80);
    const view = render(live(first));
    frames(70);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(shown()).toBe(first);
    view.rerender(live(`${first} ${'b'.repeat(40)}`));
    for (let frame = 0; frame < 6; frame++) {
      frames(1);
      expect(shown().length - first.length).toBe(fresh().length);
      for (const char of fresh()) expect(Number(char.style.opacity)).toBeLessThan(1);
    }
    expect(fresh().length).toBeGreaterThan(0);
  });

  it('starts the next utterance at a gentle pace after one ends mid-reveal', () => {
    const view = render(live('a'.repeat(80)));
    frames(10);
    view.rerender(live('a'.repeat(80), true));
    view.rerender(live(''));
    frames(30);
    view.rerender(live('b'.repeat(60)));
    const counts = [shown().length];
    for (let frame = 0; frame < 10; frame++) {
      frames(1);
      counts.push(shown().length);
    }
    const steps = counts.slice(1).map((count, i) => count - (counts[i] ?? 0));
    expect(Math.max(...steps)).toBeLessThanOrEqual(2);
  });

  it('shows words as they arrive under reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
    const view = render(live('hello'));
    expect(shown()).toBe('hello');
    view.rerender(live('hello there'));
    expect(shown()).toBe('hello there');
    expect(fresh()).toHaveLength(0);
  });

  it('keeps revealing while the recognizer sends updates every frame', () => {
    const words = 'one two three four five six seven eight nine ten';
    const view = render(live(words.slice(0, 5)));
    for (let end = 6; end <= words.length; end++) {
      view.rerender(live(words.slice(0, end)));
      frames(1);
    }
    expect(shown().length).toBeGreaterThan(10);
  });

  it('never splits an emoji or an accented letter', () => {
    const speech = 'ok 👍🏽 café 🇯🇵 done';
    render(live(speech));
    const seen = new Set<string>();
    for (let frame = 0; frame < 120; frame++) {
      frames(1);
      seen.add(shown());
    }
    const whole = [...new Intl.Segmenter().segment(speech)].map((part) => part.index);
    for (const text of seen) expect(whole.includes(text.length) || text === speech).toBe(true);
    expect(shown()).toBe(speech);
  });
});
