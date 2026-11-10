import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoComposer } from '../NeoComposer.tsx';
import type { NeoAttachment } from '../neo-attachments.ts';

const attachments = vi.hoisted(() => ({ files: [] as NeoAttachment[], reading: 0 }));
vi.mock('../neo-attachments.ts', async (original) => ({
  ...(await original<typeof import('../neo-attachments.ts')>()),
  useNeoAttachments: () => ({
    files: attachments.files,
    reading: attachments.reading,
    add: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
  }),
}));

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
const stop = () => screen.queryByRole('button', { name: 'Stop', exact: true });
const send = () => screen.queryByRole('button', { name: 'Send message' });

beforeEach(() => {
  vi.clearAllMocks();
  attachments.files = [];
  attachments.reading = 0;
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
  it.each(['', '   '])('shows only Stop during a turn with empty draft %j', (draft) => {
    const onStop = vi.fn();
    mount(true, draft, onStop);
    fireEvent.focusIn(screen.getByRole('textbox', { name: 'Message Neo' }));
    expect(send()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop', exact: true }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('replaces Stop with Send when a new draft is present during a turn', () => {
    mount(true, 'A new request', vi.fn());
    expect(stop()).toBeNull();
    expect((send() as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers Send instead of Stop for a staged attachment during a turn', () => {
    attachments.files = [{ id: 'notes', name: 'notes.txt', size: 2, kind: 'text', text: 'hi' }];
    mount(true, '', vi.fn());
    expect(stop()).toBeNull();
    expect((send() as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps an empty unfocused composer collapsed when a question arrives', () => {
    const { store } = mount(false, '');
    act(() => {
      store.agentState.value = { status: 'waiting_for_input' };
    });
    expect(send()).toBeNull();
    fireEvent.focusIn(screen.getByRole('textbox', { name: 'Message Neo' }));
    expect(send()).toBeTruthy();
  });

  it.each(['', '   '])('disables expanded Send for an empty draft %j', (draft) => {
    mount(false, draft);
    fireEvent.focusIn(screen.getByRole('textbox', { name: 'Message Neo' }));
    expect((send() as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows why a silent turn waits, then drops the line when output returns', () => {
    const { store } = mount(true, '');
    const line = 'The connection got stuck. Reconnecting.';
    expect(screen.queryByText(line)).toBeNull();
    act(() => {
      store.agentState.value = { status: 'processing', waiting: 'reconnecting' } as never;
    });
    expect(screen.getByText(line)).toBeTruthy();
    act(() => {
      store.agentState.value = { status: 'processing' } as never;
    });
    expect(screen.queryByText(line)).toBeNull();
  });

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
    expect(input.getAttribute('rows')).toBe('1');
    if (attention === 'error')
      expect(screen.getByRole('status').textContent).toContain('needs you');
    else expect(screen.queryByText(/A quick question/)).toBeNull();
    act(() => {
      store.error.value = null;
      store.agentState.value = { status: 'idle' };
    });
    expect(input.getAttribute('rows')).toBe('1');
  });

  it('says there is no network and will not send until it is back', () => {
    const { store } = mount(false, 'Hello');
    const send = () => screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;
    expect(send().disabled).toBe(false);
    act(() => {
      store.agentState.value = {
        status: 'rate_limit_cooldown',
        reason: 'network',
        retryCount: 0,
        maxRetries: 0,
        retryAt: 1,
      } as never;
    });
    expect(screen.getByRole('status').textContent).toContain('No network');
    expect(send().disabled).toBe(true);
    act(() => {
      store.agentState.value = { status: 'idle' };
    });
    expect(send().disabled).toBe(false);
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
