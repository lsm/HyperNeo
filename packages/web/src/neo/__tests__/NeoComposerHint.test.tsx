import { cleanup, render, screen } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoComposer } from '../NeoComposer.tsx';

vi.mock('../NeoPreferences.tsx', () => ({ NeoPreferences: () => null }));
vi.mock('../NeoVoice.tsx', () => ({ NeoVoice: () => null }));
vi.mock('../../lib/state.ts', () => ({
  connectionState: { value: 'connected', subscribe: () => () => {} },
}));

function makeStore(): SessionStore {
  return {
    sdkMessages: signal([]),
    agentState: signal({ status: 'idle' }),
    sessionInfo: signal({ metadata: {} }),
    hasMoreMessages: signal(false),
    error: signal(null),
    isWorking: signal(false),
    refresh: vi.fn(),
  } as unknown as SessionStore;
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn() }));
});
afterEach(() => cleanup());

describe('Neo composer context hint', () => {
  it('renders the context hint inside the composer control row, not as its own line', () => {
    const { container } = render(
      <NeoComposer
        store={makeStore()}
        sessionId="neo-1"
        draft=""
        onDraft={vi.fn()}
        onError={vi.fn()}
        onTranscript={vi.fn()}
        onSend={vi.fn()}
      />
    );
    const hint = screen.getByText('Neo holds the context. HyperNeo does the work. You stay in control.');
    const row = container.querySelector('form > div.flex');
    expect(row).toBeTruthy();
    expect(row!.contains(hint)).toBe(true);
    expect(hint.parentElement).toBe(row);
    expect(container.querySelector('form')!.lastElementChild).toBe(row);
  });
});
