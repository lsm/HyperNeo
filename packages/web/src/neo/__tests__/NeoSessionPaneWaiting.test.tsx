import { act, cleanup, render, screen } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoSessionPane } from '../NeoSessionPane.tsx';

const store = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../lib/session-store.ts', () => ({
  SessionStore: class {
    constructor() {
      Object.assign(this, store.current);
    }
  },
}));
vi.mock('../../hooks/useInputDraft.ts', () => ({
  useInputDraft: () => ({ content: '', setContent: vi.fn(), clear: vi.fn() }),
}));
vi.mock('../../hooks/useInterrupt.ts', () => ({
  useInterrupt: () => ({ handleInterrupt: vi.fn() }),
}));
vi.mock('../NeoComposer.tsx', () => ({ NeoComposer: () => null }));

afterEach(cleanup);

describe('NeoSessionPane', () => {
  it('replaces the busy word with the waiting line, then restores it', () => {
    const agentState = signal<unknown>({ status: 'processing' });
    store.current = {
      agentState,
      isWorking: signal(true),
      sdkMessages: signal([]),
      messagesLoaded: signal(true),
      hasMoreMessages: signal(false),
      sessionState: signal(null),
      error: signal(null),
      select: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    };
    render(<NeoSessionPane sessionId="s" title="Worker" />);
    expect(screen.getByText('Working…')).toBeTruthy();
    act(() => {
      agentState.value = { status: 'processing', waiting: 'model' };
    });
    expect(screen.queryByText('Working…')).toBeNull();
    expect(screen.getByText(/The model hasn't answered yet/)).toBeTruthy();
    act(() => {
      agentState.value = { status: 'processing' };
    });
    expect(screen.getByText('Working…')).toBeTruthy();
  });
});
