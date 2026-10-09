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
function composer() {
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
      draft="Fictional draft about lunch"
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
  it.each<VoicePhase>(['recording', 'working'])(
    'hides the draft and placeholder during %s and shows them again afterwards',
    (phase) => {
      voice.phase = phase;
      const { rerender } = render(composer());
      expect(textarea().classList.contains('invisible')).toBe(true);

      voice.phase = 'idle';
      rerender(composer());
      expect(textarea().classList.contains('invisible')).toBe(false);
      expect(textarea().value).toBe('Fictional draft about lunch');
      expect(onDraft).not.toHaveBeenCalled();
    }
  );
});
