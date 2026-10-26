import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { useEffect } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'preact';
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
function composer(
  draft = 'Fictional draft about lunch',
  props: Partial<ComponentProps<typeof NeoComposer>> = {}
) {
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
      {...props}
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

it('keeps the ordinary worker composer outside Neo Preview binding', async () => {
  const onSend = vi.fn().mockResolvedValue({ ok: true, created: true, messageId: 'worker-send' });
  const reference = {
    artifactId: 'registered-report',
    snapshot: 'a'.repeat(64),
    displayName: 'Neo-only report',
    state: 'available' as const,
  };
  render(
    composer('Worker-specific request', {
      forSession: true,
      previewContext: reference,
      previewCandidate: { ...reference, artifactId: 'different-report' },
      onSend,
    })
  );
  expect(screen.queryByText(/Neo-only report/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Use current Preview' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(onSend.mock.calls[0][0]).not.toHaveProperty('previewContext');
});

describe('Neo composer draft while voice is active', () => {
  it.each<VoicePhase>(['recording', 'working', 'drafting', 'sending'])(
    'shows the draft read-only at the same height during %s, then editable and focused',
    (phase) => {
      const { rerender } = render(composer());
      fireEvent.focus(textarea());
      const idleHeight = textarea().style.height;
      expect(idleHeight).not.toBe('');

      voice.phase = phase;
      rerender(composer());
      expect(screen.queryByRole('textbox', { name: 'Message Neo' })).toBeNull();
      const preview = screen.getByTestId('voice-recording-draft');
      expect(preview.textContent).toContain('Fictional draft about lunch');
      expect(preview.getAttribute('aria-readonly')).toBe('true');
      expect(preview.style.height).toBe(idleHeight);

      voice.phase = 'idle';
      rerender(composer());
      expect(textarea().style.height).toBe(idleHeight);
      expect(document.activeElement).toBe(textarea());
      expect(textarea().selectionStart).toBe('Fictional draft about lunch'.length);
      expect(onDraft).not.toHaveBeenCalled();
    }
  );

  it.each<VoicePhase>(['drafting', 'sending'])(
    'marks where the transcript will appear while %s',
    (phase) => {
      voice.phase = phase;
      render(composer());
      expect(screen.getByTestId('voice-transcribing-placeholder')).toBeTruthy();
    }
  );

  it('shows a caret, not the transcribing placeholder, while recording', () => {
    voice.phase = 'recording';
    render(composer());
    expect(screen.queryByTestId('voice-transcribing-placeholder')).toBeNull();
  });

  it('hands the attach and model controls over to the voice bar while voice is active', () => {
    voice.phase = 'recording';
    const { rerender } = render(composer());
    const attach = screen.getByRole('button', {
      name: 'Attach photos or files',
    }) as HTMLButtonElement;
    expect(attach.disabled).toBe(true);

    voice.phase = 'idle';
    rerender(composer());
    expect(attach.disabled).toBe(false);
  });

  it('tells an empty draft where the dictated words will appear', () => {
    voice.phase = 'recording';
    render(composer(''));
    expect(screen.getByTestId('voice-recording-draft').textContent).toBe(
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

describe('Neo composer focus layout', () => {
  it('expands an empty composer on focus and collapses again after blur', () => {
    render(composer(''));
    const textarea = () =>
      screen.getByRole('textbox', { name: 'Message Neo' }) as HTMLTextAreaElement;
    expect(textarea().getAttribute('rows')).toBe('1');
    fireEvent.focus(textarea());
    expect(textarea().getAttribute('rows')).toBe('2');
    fireEvent.focusOut(textarea(), { relatedTarget: document.body });
    expect(textarea().getAttribute('rows')).toBe('1');
    expect(textarea().value).toBe('');
  });

  it('keeps the expanded layout while moving focus to a composer control', () => {
    render(composer());
    fireEvent.focus(textarea());
    fireEvent.focusOut(textarea(), {
      relatedTarget: screen.getByRole('button', { name: 'Send message' }),
    });
    expect(textarea().getAttribute('rows')).toBe('2');
  });

  it.each(['First line\nSecond line', ' '])(
    'keeps an unfocused nonempty draft expanded: %j',
    (draft) => {
      render(composer(draft));
      const input = screen.getByRole('textbox', { name: 'Message Neo' }) as HTMLTextAreaElement;
      expect(input.getAttribute('rows')).toBe('2');
      expect(input.value).toBe(draft);
      fireEvent.focus(input);
      expect(input.getAttribute('rows')).toBe('2');
      fireEvent.focusOut(input, { relatedTarget: document.body });
      expect(input.getAttribute('rows')).toBe('2');
      expect(input.value).toBe(draft);
    }
  );

  it('keeps recording send controls available with no text', () => {
    voice.phase = 'recording';
    render(composer(''));
    expect(
      screen.getByRole('button', { name: 'Stop recording and send the message' })
    ).toBeTruthy();
  });
});
