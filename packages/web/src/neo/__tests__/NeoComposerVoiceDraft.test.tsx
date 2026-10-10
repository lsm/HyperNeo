import { signal } from '@preact/signals';
import { cleanup, render, screen } from '@testing-library/preact';
import { useEffect } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoComposer } from '../NeoComposer.tsx';
import type { VoicePhase } from '../NeoVoice.tsx';

const voice = vi.hoisted(() => ({ phase: 'idle' as VoicePhase }));
vi.mock('../../hooks/useInterrupt.ts', () => ({
  useInterrupt: () => ({ handleInterrupt: vi.fn(), interrupting: false }),
}));
vi.mock('../NeoPreferences.tsx', () => ({ NeoPreferences: () => null }));
vi.mock('../NeoVoice.tsx', () => ({
  NeoVoice: ({ onPhase }: { onPhase: (phase: VoicePhase) => void }) => {
    useEffect(() => onPhase(voice.phase));
    return null;
  },
}));
vi.mock('../../lib/state.ts', () => ({
  connectionState: { value: 'connected', subscribe: () => () => {} },
}));

const onDraft = vi.fn();
function composer(draft = 'Fictional draft about lunch') {
  const store = {
    sdkMessages: signal([]),
    agentState: signal({ status: 'idle' }),
    sessionInfo: signal({ metadata: {} }),
    hasMoreMessages: signal(false),
    error: signal(null),
    isWorking: signal(false),
    refresh: vi.fn(),
  } as unknown as SessionStore;
  return (
    <NeoComposer
      store={store}
      sessionId="neo-1"
      draft={draft}
      onDraft={onDraft}
      onError={vi.fn()}
      onTranscript={vi.fn()}
      onSend={vi.fn()}
    />
  );
}
const textarea = () =>
  screen.getByDisplayValue('Fictional draft about lunch') as HTMLTextAreaElement;

beforeEach(() => {
  vi.clearAllMocks();
  voice.phase = 'idle';
  vi.stubGlobal(
    'matchMedia',
    vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Neo composer draft while voice is active', () => {
  it.each<VoicePhase>(['recording', 'working', 'drafting', 'sending'])(
    'keeps the draft visible, muted and read-only during %s, then editable and focused',
    (phase) => {
      voice.phase = phase;
      const { rerender } = render(composer());
      expect(textarea().classList.contains('invisible')).toBe(false);
      expect(textarea().classList.contains('text-fg-muted')).toBe(true);
      expect(textarea().disabled).toBe(true);

      voice.phase = 'idle';
      rerender(composer());
      expect(textarea().classList.contains('text-fg')).toBe(true);
      expect(textarea().disabled).toBe(false);
      expect(document.activeElement).toBe(textarea());
      expect(textarea().selectionStart).toBe('Fictional draft about lunch'.length);
      expect(onDraft).not.toHaveBeenCalled();
    }
  );

  it('hands the attach and model controls over to the voice bar while voice is active', () => {
    voice.phase = 'recording';
    const { rerender } = render(composer());
    const attach = screen.getByRole('button', { name: 'Attach photos or files' });
    expect(attach.parentElement?.classList.contains('hidden')).toBe(true);

    voice.phase = 'idle';
    rerender(composer());
    expect(attach.parentElement?.classList.contains('hidden')).toBe(false);
  });

  it('tells an empty draft where the dictated words will appear', () => {
    voice.phase = 'recording';
    render(composer(''));
    expect(screen.getByLabelText('Message Neo').getAttribute('placeholder')).toBe(
      'Listening. Your words appear here.'
    );
  });

  it('says where a transcript is going once recording stops', () => {
    voice.phase = 'drafting';
    const { rerender } = render(composer());
    expect(screen.getByRole('status').textContent).toBe('Transcribing into your draft…');

    voice.phase = 'sending';
    rerender(composer());
    expect(screen.getByRole('status').textContent).toBe('Sending with your draft…');

    rerender(composer(''));
    expect(screen.queryByText('Sending with your draft…')).toBeNull();
  });
});
