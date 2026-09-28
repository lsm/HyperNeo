import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoWorkCard } from '../NeoWorkCard.tsx';
import { NeoConversation } from '../NeoConversation.tsx';
import { NeoComposer } from '../NeoComposer.tsx';

const sendMessage = vi.hoisted(() => vi.fn());
const interrupt = vi.hoisted(() => vi.fn());
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
  sendMessage.mockResolvedValue({
    ok: true,
    requestId: 'request',
    messageId: 'request',
    created: true,
  });
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
      {
        type: 'user',
        uuid: 'neo-consult:one:request',
        message: { role: 'user', content: 'Internal consultation question' },
        inputKind: 'system',
      },
      {
        type: 'user',
        uuid: 'neo-consult:one:reply',
        message: { role: 'user', content: 'Internal consultation answer' },
        inputKind: 'system',
      },
    ] as unknown as SessionStore['sdkMessages']['value'];
    render(<NeoConversation store={store} sessionId="neo" />);
    const conversation = screen.getByRole('region', { name: 'Conversation with Neo' });
    expect(within(conversation).getByText('42.').tagName).toBe('P');
    expect(within(conversation).getByText('What is 17 plus 25?')).toBeTruthy();
    fireEvent.click(within(conversation).getByRole('button', { name: 'What happened' }));
    expect(within(conversation).getByText('Neo answered directly.')).toBeTruthy();
    expect(within(conversation).queryByText('Internal worker report')).toBeNull();
    expect(within(conversation).queryByText('Internal consultation question')).toBeNull();
    expect(within(conversation).queryByText('Internal consultation answer')).toBeNull();
    expect(screen.queryByText('Behind the conversation')).toBeNull();
    expect(screen.queryByRole('link', { name: /Open full conversation/ })).toBeNull();
  });
  it('opens a completed execution response from the Neo reply that announced it', () => {
    const store = makeStore();
    store.sdkMessages.value = [
      {
        type: 'user',
        uuid: 'work',
        inputKind: 'system',
        message: { role: 'user', content: 'A delegated session returned.' },
      },
      {
        type: 'assistant',
        uuid: 'reply',
        message: { role: 'assistant', content: 'The draft is ready.' },
      },
      { type: 'result', uuid: 'result', subtype: 'success' },
    ] as unknown as SessionStore['sdkMessages']['value'];
    render(
      <NeoConversation
        store={store}
        sessionId="neo"
        works={[{ ...work, status: 'reported', report: 'Dear neighbors, join us Sunday.' }]}
      />
    );
    const reply = screen.getByText('The draft is ready.').closest('article')!;
    const result = within(reply).getByText('Read result · Draft the agenda');
    expect(result.closest('details')?.open).toBe(false);
    fireEvent.click(result);
    expect(result.closest('details')?.open).toBe(true);
    expect(within(reply).getByText('Dear neighbors, join us Sunday.')).toBeTruthy();
    expect(within(reply).getByRole('button', { name: 'Copy work result' })).toBeTruthy();
  });
  it('keeps each reply’s activity beside its own copy control', () => {
    const store = makeStore();
    store.sdkMessages.value = [
      { type: 'user', uuid: 'human', message: { role: 'user', content: 'Brief' } },
      {
        type: 'assistant',
        uuid: 'tool',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'mcp__hyperneo-operations__invoke',
              input: { name: 'neo.snapshot', input: {} },
            },
          ],
        },
      },
      { type: 'assistant', uuid: 'reply', message: { role: 'assistant', content: 'All clear.' } },
      { type: 'result', uuid: 'result', subtype: 'success' },
    ] as unknown as SessionStore['sdkMessages']['value'];
    render(<NeoConversation store={store} sessionId="neo" />);
    const reply = screen.getByText('All clear.').closest('article')!;
    expect(within(reply).getByRole('button', { name: 'Copy Neo’s message' })).toBeTruthy();
    const activityButton = within(reply).getByRole('button', { name: 'What happened' });
    fireEvent.click(activityButton);
    expect(within(reply).getByText('Checked what Neo knows')).toBeTruthy();
    expect(
      within(reply).getByRole('link', { name: 'Open technical trace ↗' }).getAttribute('href')
    ).toBe('/session/neo');
    fireEvent.click(within(reply).getByRole('button', { name: 'Hide activity' }));
    expect(within(reply).queryByText('Checked what Neo knows')).toBeNull();
  });
  it('exposes pending questions and runtime failures instead of hiding them in tool detail', () => {
    const agentState = signal<{ status: string; pendingQuestion?: { toolUseId: string } }>({
      status: 'idle',
    });
    const error = signal<{ message: string; occurredAt: number } | null>(null);
    const store = { ...makeStore(), agentState, error } as unknown as SessionStore;
    agentState.value = { status: 'waiting_for_input', pendingQuestion: { toolUseId: 'choose' } };
    render(<NeoConversation store={store} sessionId="neo" />);
    expect(screen.getByText('Question: choose')).toBeTruthy();
    act(() => {
      error.value = { message: 'Authentication required', occurredAt: 1 };
    });
    expect(screen.getByRole('alert').textContent).toBe('Authentication required');
  });
  it('shows Neo working in the conversation until the reply completes', () => {
    const agentState = signal<SessionStore['agentState']['value']>({ status: 'idle' });
    const store = { ...makeStore(), agentState } as unknown as SessionStore;
    store.sdkMessages.value = [
      { type: 'user', uuid: 'human', message: { role: 'user', content: 'A quick question' } },
    ] as unknown as SessionStore['sdkMessages']['value'];
    const view = render(<NeoConversation store={store} sessionId="neo" />);
    const conversation = screen.getByRole('region', { name: 'Conversation with Neo' });
    act(() => {
      agentState.value = { status: 'queued', messageId: 'human' };
    });
    expect(within(conversation).getByRole('status').textContent).toContain('Neo is getting ready');
    expect(within(conversation).getByRole('status').querySelectorAll('i')).toHaveLength(3);
    expect(conversation.querySelector('.neo-progress-bubble')).toBeNull();
    act(() => {
      agentState.value = {
        status: 'processing',
        messageId: 'human',
        phase: 'thinking',
      };
    });
    expect(within(conversation).getByRole('status').textContent).toContain('Neo is working');
    act(() => {
      store.sdkMessages.value = [
        ...store.sdkMessages.value,
        { type: 'assistant', uuid: 'reply', message: { role: 'assistant', content: 'Here.' } },
        { type: 'result', uuid: 'result', subtype: 'success' },
      ] as unknown as SessionStore['sdkMessages']['value'];
      agentState.value = { status: 'idle' };
    });
    view.rerender(<NeoConversation store={store} sessionId="neo" />);
    expect(within(conversation).queryByRole('status')).toBeNull();
    expect(within(conversation).getByText('Here.')).toBeTruthy();
  });
  it('sends through the supplied durable intake client without creating a concern', async () => {
    const onDraft = vi.fn();
    render(
      <NeoComposer
        store={makeStore()}
        sessionId="neo"
        draft="A one-off question"
        onDraft={onDraft}
        onTranscript={vi.fn()}
        onError={vi.fn()}
        onSend={sendMessage}
      />
    );
    expect(screen.getByRole('textbox', { name: 'Message Neo' })).toBeTruthy();
    expect(screen.queryByText('What would you like off your mind?')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Send message' }).querySelector('path')?.getAttribute('d')
    ).toBe('M12 19V5m-6 6 6-6 6 6');
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        sessionId: 'neo',
        text: 'A one-off question',
        images: [],
      })
    );
    await waitFor(() => expect(onDraft).toHaveBeenCalledWith(''));
  });
  it('does not erase text typed while an earlier message is being accepted', async () => {
    let accept: () => void = () => {};
    sendMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = () =>
            resolve({ ok: true, requestId: 'request', messageId: 'request', created: true });
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
        onSend={sendMessage}
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
        onSend={sendMessage}
      />
    );
    accept();
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
    expect(onDraft).not.toHaveBeenCalledWith('');
  });
});
