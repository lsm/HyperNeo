import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoComposer } from '../NeoComposer.tsx';
import { neoEnterSends } from '../NeoComposer.tsx';

const sendMessage = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('../../hooks/useSendMessage.ts', () => ({
  useSendMessage: () => ({ sendMessage, clearSendTimeout: vi.fn() }),
}));
vi.mock('../../hooks/useInterrupt.ts', () => ({
  useInterrupt: () => ({ handleInterrupt: vi.fn(), interrupting: false }),
}));
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

function setPointerCoarse(coarse: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi
      .fn()
      .mockReturnValue({ matches: coarse, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  );
}

function renderComposer(initialDraft = '') {
  const draft = signal(initialDraft);
  const onDraft = vi.fn((value: string) => {
    draft.value = value;
  });
  const onSend = vi.fn(
    async () =>
      ({
        ok: true,
        requestId: 'request-1',
        messageId: 'message-1',
        created: true,
      }) as const
  );
  const props = () => (
    <NeoComposer
      store={makeStore()}
      sessionId="neo-1"
      draft={draft.value}
      onDraft={onDraft}
      onError={vi.fn()}
      onTranscript={vi.fn()}
      onSend={onSend}
    />
  );
  const view = render(props());
  const textarea = () => view.container.querySelector('textarea') as HTMLTextAreaElement;
  const enter = (overrides: Partial<KeyboardEventInit> = {}) =>
    fireEvent.keyDown(textarea(), { key: 'Enter', ...overrides });
  const rerender = () => view.rerender(props());
  return { draft, onDraft, onSend, textarea, enter, rerender };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('neoEnterSends rule', () => {
  it('touch: plain Return never sends; modifier+Enter does', () => {
    expect(neoEnterSends({ shiftKey: false, metaKey: false, ctrlKey: false }, true)).toBe(false);
    expect(neoEnterSends({ shiftKey: false, metaKey: false, ctrlKey: false }, false)).toBe(true);
    expect(neoEnterSends({ shiftKey: true, metaKey: false, ctrlKey: false }, false)).toBe(false);
    expect(neoEnterSends({ shiftKey: false, metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(neoEnterSends({ shiftKey: false, metaKey: false, ctrlKey: true }, true)).toBe(true);
  });
});

describe('NeoComposer Enter behavior', () => {
  it('iOS-style touch keyboard: Return inserts a newline and does not send', async () => {
    setPointerCoarse(true);
    const { textarea, enter, onSend } = renderComposer();

    fireEvent.input(textarea(), { target: { value: 'one' } });
    enter();
    fireEvent.input(textarea(), { target: { value: 'one\ntwo' } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(textarea().value).toBe('one\ntwo');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Android-style touch keyboard with an IME: Enter while composing never sends', async () => {
    setPointerCoarse(true);
    const { textarea, enter, onSend } = renderComposer();

    fireEvent.input(textarea(), { target: { value: 'こん' } });
    enter({ isComposing: true });
    enter({ keyCode: 229 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onSend).not.toHaveBeenCalled();
  });

  it('touch with a physical keyboard: Cmd/Ctrl+Enter sends, plain Enter still newlines', async () => {
    setPointerCoarse(true);
    const { textarea, enter, onSend, rerender } = renderComposer('send me');
    expect(textarea().value).toBe('send me');

    enter({ metaKey: true });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    fireEvent.input(textarea(), { target: { value: 'again' } });
    rerender();
    enter();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('multiline drafts survive intact on touch (no partial sends)', async () => {
    setPointerCoarse(true);
    const { textarea, enter, onSend } = renderComposer();

    for (const [index, line] of ['alpha', 'beta', 'gamma'].entries()) {
      const value = index === 0 ? line : `${textarea().value}\n${line}`;
      fireEvent.input(textarea(), { target: { value } });
      enter();
    }

    expect(textarea().value).toBe('alpha\nbeta\ngamma');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('desktop keyboard: Enter sends, Shift+Enter adds a newline', async () => {
    setPointerCoarse(false);
    const { textarea, enter, onSend, rerender } = renderComposer('hello');

    enter();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    fireEvent.input(textarea(), { target: { value: 'next' } });
    rerender();
    enter({ shiftKey: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('shows the touch send hint at phone widths, not only on >=640px', () => {
    setPointerCoarse(true);
    renderComposer();
    const hint = document.querySelector('[role="status"]') as HTMLElement;
    expect(hint.className).not.toContain('hidden');
    expect(hint.textContent).toContain('Return adds a line');
  });

  it('keeps the send button labeled and keyboard reachable', () => {
    setPointerCoarse(true);
    renderComposer();
    const button = screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('submit');
  });
});
