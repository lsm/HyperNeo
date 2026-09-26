import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoWorkCard } from '../NeoWorkCard.tsx';
import { NeoConversation } from '../NeoConversation.tsx';
import { NeoComposer } from '../NeoComposer.tsx';

const sendMessage = vi.hoisted(() => vi.fn(async () => true));
const clearSendTimeout = vi.hoisted(() => vi.fn());
const interrupt = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useSendMessage.ts', () => ({
  useSendMessage: () => ({ sendMessage, clearSendTimeout }),
}));
vi.mock('../../hooks/useInterrupt.ts', () => ({
  useInterrupt: () => ({ handleInterrupt: interrupt, interrupting: false }),
}));
vi.mock('../NeoPreferences.tsx', () => ({ NeoPreferences: () => null }));
vi.mock('../NeoVoice.tsx', () => ({ NeoVoice: () => null }));
vi.mock('../../lib/state.ts', () => ({ connectionState: { value: 'connected' } }));
vi.mock('../../components/chat/MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('../../components/sdk/SDKMessageRenderer.tsx', () => ({ SDKMessageRenderer: () => null }));
vi.mock('../../components/QuestionPrompt.tsx', () => ({
  QuestionPrompt: ({ pendingQuestion }: { pendingQuestion: { toolUseId: string } }) => (
    <div>Question: {pendingQuestion.toolUseId}</div>
  ),
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
const work: NeoWork = {
  id: 'work',
  requestKey: 'request',
  concernId: null,
  originSessionId: 'neo',
  title: 'Draft the agenda',
  instruction: 'Eight people, Sunday. Do not book anything.',
  sessionId: null,
  status: 'proposed',
  report: null,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  sendMessage.mockResolvedValue(true);
});
afterEach(cleanup);

describe('Neo MVP controls', () => {
  it('proposals require an explicit Start and cancellation is a separate action', () => {
    const action = vi.fn();
    render(<NeoWorkCard work={work} busy={false} disabled={false} onAction={action} />);
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByText(work.instruction)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }));
    expect(action).toHaveBeenCalledWith('work', 'start');
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(action).toHaveBeenCalledWith('work', 'cancel');
  });
  it('disables duplicate work actions and does not call a returned report verified completion', () => {
    const action = vi.fn();
    const view = render(<NeoWorkCard work={work} busy disabled={false} onAction={action} />);
    expect((screen.getByRole('button', { name: 'Starting…' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    view.rerender(
      <NeoWorkCard
        work={{
          ...work,
          status: 'reported',
          sessionId: 'worker-one',
          report: 'A draft, not a booking.',
        }}
        busy={false}
        disabled={false}
        onAction={action}
      />
    );
    expect(screen.getByText('Response ready')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start work' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Inspect execution ↗' }).getAttribute('href')).toBe(
      '/session/worker-one'
    );
    expect(screen.getByText('A draft, not a booking.')).toBeTruthy();
  });
  it('shows conversation text but keeps synthetic worker returns out of the human transcript', () => {
    const store = makeStore();
    store.sdkMessages.value = [
      { type: 'user', uuid: 'human', message: { role: 'user', content: 'What is 17 plus 25?' } },
      { type: 'assistant', uuid: 'answer', message: { content: [{ type: 'text', text: '42.' }] } },
      { type: 'result', uuid: 'result', subtype: 'success' },
      {
        type: 'user',
        uuid: 'work',
        message: { role: 'user', content: 'Internal worker report' },
        inputKind: 'system',
      },
    ] as unknown as SessionStore['sdkMessages']['value'];
    render(<NeoConversation store={store} sessionId="neo" />);
    const conversation = screen.getByRole('region', { name: 'Conversation with Neo' });
    expect(within(conversation).getByText('42.').tagName).toBe('P');
    expect(within(conversation).getByText('What is 17 plus 25?')).toBeTruthy();
    expect(within(conversation).queryByText('Internal worker report')).toBeNull();
    expect(screen.getByText('Behind the conversation')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open full conversation/ }).getAttribute('href')).toBe(
      '/session/neo'
    );
    const toggle = screen.getByRole('button', { name: 'Behind the conversation' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });
  it('exposes pending questions and runtime failures instead of hiding them in tool detail', () => {
    const store = makeStore();
    Object.assign(store, {
      agentState: signal({ status: 'waiting_for_input', pendingQuestion: { toolUseId: 'choose' } }),
    });
    const view = render(<NeoConversation store={store} sessionId="neo" />);
    expect(screen.getByText('Question: choose')).toBeTruthy();
    Object.assign(store, { error: signal({ message: 'Authentication required', occurredAt: 1 }) });
    view.rerender(<NeoConversation store={store} sessionId="neo" />);
    expect(screen.getByRole('alert').textContent).toBe('Authentication required');
  });
  it('sends through the existing message path without creating a concern', async () => {
    const onDraft = vi.fn();
    render(
      <NeoComposer
        store={makeStore()}
        sessionId="neo"
        draft="A one-off question"
        onDraft={onDraft}
        onTranscript={vi.fn()}
        onError={vi.fn()}
      />
    );
    expect(screen.getByRole('textbox', { name: 'Message Neo' })).toBeTruthy();
    expect(screen.queryByText('What would you like off your mind?')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Send message' }).querySelector('path')?.getAttribute('d')
    ).toBe('M12 19V5m-6 6 6-6 6 6');
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('A one-off question'));
    await waitFor(() => expect(onDraft).toHaveBeenCalledWith(''));
  });
  it('does not erase text typed while an earlier message is being accepted', async () => {
    let accept: (value: boolean) => void = () => {};
    sendMessage.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        })
    );
    const onDraft = vi.fn();
    const store = makeStore();
    const view = render(
      <NeoComposer
        store={store}
        sessionId="neo"
        draft="First"
        onDraft={onDraft}
        onTranscript={vi.fn()}
        onError={vi.fn()}
      />
    );
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);
    view.rerender(
      <NeoComposer
        store={store}
        sessionId="neo"
        draft="New thought"
        onDraft={onDraft}
        onTranscript={vi.fn()}
        onError={vi.fn()}
      />
    );
    accept(true);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
    expect(onDraft).not.toHaveBeenCalledWith('');
  });
});
