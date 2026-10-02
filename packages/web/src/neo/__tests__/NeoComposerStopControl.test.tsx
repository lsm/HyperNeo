import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoComposer } from '../NeoComposer.tsx';

const interrupt = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useInterrupt.ts', () => ({
  useInterrupt: () => ({ handleInterrupt: interrupt, interrupting: false }),
}));
vi.mock('../NeoPreferences.tsx', () => ({ NeoPreferences: () => null }));
vi.mock('../NeoVoice.tsx', () => ({ NeoVoice: () => null }));
vi.mock('../../lib/state.ts', () => ({
  connectionState: { value: 'connected', subscribe: () => () => {} },
}));

function mount(working: boolean, draft: string) {
  const store = {
    sdkMessages: signal([]),
    agentState: signal({ status: working ? 'processing' : 'idle' }),
    sessionInfo: signal({ metadata: {} }),
    hasMoreMessages: signal(false),
    error: signal(null),
    isWorking: signal(working),
    refresh: vi.fn(),
  } as unknown as SessionStore;
  return render(
    <NeoComposer
      store={store}
      sessionId="neo-1"
      draft={draft}
      onDraft={vi.fn()}
      onError={vi.fn()}
      onTranscript={vi.fn()}
      onSend={vi.fn()}
    />
  );
}
const stop = () => screen.queryByRole('button', { name: 'Stop Neo' });
const send = () => screen.queryByRole('button', { name: 'Send message' });

beforeEach(() => {
  vi.clearAllMocks();
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

describe('Neo composer send and stop slot', () => {
  it('shows only Send while Neo is idle', () => {
    mount(false, '');
    expect(send()).toBeTruthy();
    expect(stop()).toBeNull();
  });

  it.each(['', '   '])('turns Send into a labelled Stop while Neo works with draft %j', (draft) => {
    mount(true, draft);
    expect(send()).toBeNull();
    const button = stop()!;
    expect(button.getAttribute('title')).toBe('Stop Neo');
    expect(button.querySelector('rect, path')).toBeTruthy();
    fireEvent.click(button);
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it('keeps Send while Neo works and the human has typed a new ask', () => {
    mount(true, 'Another fictional ask');
    expect(stop()).toBeNull();
    expect((send() as HTMLButtonElement).disabled).toBe(false);
  });
});
