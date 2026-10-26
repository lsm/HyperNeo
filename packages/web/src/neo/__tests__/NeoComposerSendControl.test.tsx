import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
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

function mount(working: boolean, draft: string, onStop?: () => void) {
  const store = {
    sdkMessages: signal([]),
    agentState: signal({ status: working ? 'processing' : 'idle' }),
    sessionInfo: signal({ metadata: {} }),
    hasMoreMessages: signal(false),
    error: signal<string | null>(null),
    isWorking: signal(working),
    refresh: vi.fn(),
  };
  const view = render(
    <NeoComposer
      store={store as unknown as SessionStore}
      sessionId="neo-1"
      draft={draft}
      onDraft={vi.fn()}
      onError={vi.fn()}
      onTranscript={vi.fn()}
      onSend={vi.fn()}
      onStop={onStop}
    />
  );
  return { ...view, store };
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

describe('Neo composer send slot', () => {
  it('offers no send button until the empty composer is focused', () => {
    mount(false, '');
    expect(send()).toBeNull();
    fireEvent.focusIn(screen.getByRole('button', { name: 'Attach photos or files' }));
    expect(send()).toBeTruthy();
    fireEvent.focusOut(screen.getByRole('textbox', { name: 'Message Neo' }), {
      relatedTarget: document.body,
    });
    expect(send()).toBeNull();
  });

  it.each([
    [false, ''],
    [true, ''],
    [true, '   '],
  ])('never offers Stop Neo (working=%s, draft %j)', (working, draft) => {
    mount(working, draft);
    expect(Boolean(send())).toBe(draft.length > 0);
    expect(stop()).toBeNull();
  });

  it('keeps Send enabled while Neo works and the human has typed a new ask', () => {
    mount(true, 'Another fictional ask');
    expect((send() as HTMLButtonElement).disabled).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it.each(['error', 'waiting'] as const)('expands for %s status without focusing', (attention) => {
    const { store } = mount(false, '');
    const input = screen.getByRole('textbox', { name: 'Message Neo' });
    expect(input.getAttribute('rows')).toBe('1');
    act(() => {
      if (attention === 'error') store.error.value = 'Synthetic error';
      else store.agentState.value = { status: 'waiting_for_input' };
    });
    expect(input.getAttribute('rows')).toBe('2');
    expect(screen.getByRole('status').textContent).toContain(
      attention === 'error' ? 'needs you' : 'A quick question'
    );
    act(() => {
      store.error.value = null;
      store.agentState.value = { status: 'idle' };
    });
    expect(input.getAttribute('rows')).toBe('1');
  });

  it('offers Stop for a session’s running turn when the pane can stop it', () => {
    const onStop = vi.fn();
    mount(false, '', onStop);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    cleanup();
    mount(true, '', onStop);
    expect(screen.getByRole('textbox', { name: 'Message Neo' }).getAttribute('rows')).toBe('1');
    screen.getByRole('button', { name: 'Stop' }).click();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(send()).toBeNull();
    fireEvent.focusIn(screen.getByRole('textbox', { name: 'Message Neo' }));
    fireEvent.focusOut(screen.getByRole('textbox', { name: 'Message Neo' }), {
      relatedTarget: document.body,
    });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  });
});
