import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { VoiceDraftPreview } from '../VoiceDraftPreview.tsx';

afterEach(cleanup);

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
    const interim = screen.getByTestId('voice-interim-text');
    expect(interim.textContent).toBe('hello ne');
    expect(interim.className).toContain('text-fg-faint');
    expect(screen.getByTestId('voice-recording-draft').textContent).toBe('typed\nhello ne');
  });

  it('keeps the listening hint when nothing has been heard yet', () => {
    render(<VoiceDraftPreview text="" start={0} end={0} transcribing={false} hint="Listening…" />);
    expect(screen.queryByTestId('voice-interim-text')).toBeNull();
    expect(screen.getByText('Listening…')).toBeTruthy();
  });
});
