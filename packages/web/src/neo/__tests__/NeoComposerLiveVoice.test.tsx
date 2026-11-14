import { signal } from '@preact/signals';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoComposer } from '../NeoComposer.tsx';

type Live = { on: boolean; speaking: boolean };
const seen = vi.hoisted(() => ({
  voice: null as null | { live?: Live; onPrepareSend?: () => { sendContext?: unknown } },
  onLive: null as null | ((live: Live) => void),
}));
vi.mock('../../hooks/useInterrupt.ts', () => ({
  useInterrupt: () => ({ handleInterrupt: vi.fn(), interrupting: false }),
}));
vi.mock('../NeoPreferences.tsx', () => ({ NeoPreferences: () => null }));
vi.mock('../NeoVoice.tsx', () => ({
  NeoVoice: (props: typeof seen.voice) => {
    seen.voice = props;
    return null;
  },
}));
vi.mock('../NeoRealtimeVoice.tsx', () => ({
  NeoRealtimeVoice: ({ onLive }: { onLive: (live: Live) => void }) => {
    seen.onLive = onLive;
    return null;
  },
}));
vi.mock('../../lib/state.ts', () => ({
  connectionState: { value: 'connected', subscribe: () => () => {} },
}));

const store = {
  sdkMessages: signal([]),
  agentState: signal({ status: 'idle' }),
  sessionInfo: signal({ metadata: {} }),
  hasMoreMessages: signal(false),
  error: signal(null),
  isWorking: signal(false),
  refresh: vi.fn(),
} as unknown as SessionStore;

beforeEach(() => {
  seen.voice = null;
  seen.onLive = null;
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

describe('NeoComposer', () => {
  it('runs the mic with live voice and marks its sends as live voice', () => {
    render(
      <NeoComposer
        store={store}
        sessionId="neo-1"
        draft=""
        onDraft={vi.fn()}
        onError={vi.fn()}
        onTranscript={vi.fn()}
        onSend={vi.fn()}
      />
    );
    expect(seen.voice?.onPrepareSend?.().sendContext).not.toMatchObject({
      inputMode: 'live_voice',
    });
    act(() => seen.onLive?.({ on: true, speaking: true }));
    expect(seen.voice?.live).toEqual({ on: true, speaking: true });
    expect(seen.voice?.onPrepareSend?.().sendContext).toMatchObject({ inputMode: 'live_voice' });
  });
});
