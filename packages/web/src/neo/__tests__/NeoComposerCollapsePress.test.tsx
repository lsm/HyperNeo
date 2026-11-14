import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoComposer } from '../NeoComposer.tsx';

vi.mock('../NeoPreferences.tsx', () => ({ NeoPreferences: () => null }));
vi.mock('../NeoVoice.tsx', () => ({ NeoVoice: () => null }));
vi.mock('../../lib/state.ts', () => ({
  connectionState: { value: 'connected', subscribe: () => () => {} },
}));

function mount() {
  const store = {
    sdkMessages: signal([]),
    agentState: signal({ status: 'idle' }),
    sessionInfo: signal({ metadata: {} }),
    hasMoreMessages: signal(false),
    error: signal<string | null>(null),
    isWorking: signal(false),
    refresh: vi.fn(),
  };
  render(
    <NeoComposer
      store={store as unknown as SessionStore}
      sessionId="neo-1"
      draft=""
      onDraft={vi.fn()}
      onError={vi.fn()}
      onTranscript={vi.fn()}
      onSend={vi.fn()}
    />
  );
  return screen.getByRole('textbox', { name: 'Message Neo' }) as HTMLTextAreaElement;
}

beforeEach(() => {
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

describe('Neo composer collapse on pointer press', () => {
  it('keeps the expanded layout until the press that leaves it ends', async () => {
    const input = mount();
    const form = input.form!;
    act(() => input.focus());
    expect(form.className).toContain('is-focused');
    fireEvent.pointerDown(document.body, { pointerType: 'mouse' });
    fireEvent.focusOut(input, { relatedTarget: document.body });
    expect(form.className).toContain('is-focused');
    fireEvent.pointerUp(document.body, { pointerType: 'mouse' });
    await waitFor(() => expect(form.className).toContain('is-collapsed'));
  });

  it('waits for every pointer before collapsing', async () => {
    const input = mount();
    const form = input.form!;
    act(() => input.focus());
    fireEvent.pointerDown(document.body, { pointerType: 'touch', pointerId: 1 });
    fireEvent.pointerDown(document.body, { pointerType: 'touch', pointerId: 2 });
    fireEvent.focusOut(input, { relatedTarget: document.body });
    fireEvent.pointerUp(document.body, { pointerType: 'touch', pointerId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(form.className).toContain('is-focused');
    fireEvent.pointerUp(document.body, { pointerType: 'touch', pointerId: 2 });
    await waitFor(() => expect(form.className).toContain('is-collapsed'));
  });

  it('collapses right away when focus leaves without a pointer press', () => {
    const input = mount();
    const form = input.form!;
    act(() => input.focus());
    fireEvent.focusOut(input, { relatedTarget: document.body });
    expect(form.className).toContain('is-collapsed');
  });
});
