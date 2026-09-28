import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { ChatMessage } from '@hyperneo/shared';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoWorkCard } from '../NeoWorkCard.tsx';
import { NeoConversation } from '../NeoConversation.tsx';
import { NeoComposer } from '../NeoComposer.tsx';
import { neoMessageAnchor } from '../reply-context.ts';

const sendMessage = vi.hoisted(() => vi.fn());
const interrupt = vi.hoisted(() => vi.fn());
const inventoryRequest = vi.hoisted(() => vi.fn());
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request: inventoryRequest }) },
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
  originMessageId: null,
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
  inventoryRequest.mockResolvedValue({ capturedAt: 1, capabilities: [], resources: [] });
  sendMessage.mockResolvedValue({
    ok: true,
    requestId: 'request',
    messageId: 'request',
    created: true,
  });
});
afterEach(cleanup);

describe('Neo correlated work detail', () => {
  it('shows the actual returned work after SDK tool results without borrowing it for B', () => {
    const store = makeStore();
    store.sdkMessages.value = [
      { type: 'user', uuid: 'work', inputKind: 'system', message: { content: 'A returned' } },
      { type: 'user', uuid: 'ask-B', message: { content: 'Unrelated B' } },
      {
        type: 'assistant',
        uuid: 'reply-A',
        neoInputOrigin: { sessionId: 'neo', messageId: 'work' },
        message: { content: 'The agenda is ready.' },
      },
      {
        type: 'user',
        uuid: 'tool-result',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Checked state' }],
        },
      },
      { type: 'result', uuid: 'result-A' },
      {
        type: 'assistant',
        uuid: 'reply-B',
        neoInputOrigin: { sessionId: 'neo', messageId: 'ask-B' },
        message: { content: 'Separate answer B.' },
      },
      { type: 'result', uuid: 'result-B' },
    ] as unknown as ChatMessage[];
    render(
      <NeoConversation
        store={store}
        sessionId="neo"
        works={[{ ...work, status: 'reported', report: 'Actual scoped draft A.' }]}
      />
    );
    const a = screen.getByText('The agenda is ready.').closest('article')!;
    const b = screen.getByText('Separate answer B.').closest('article')!;
    const detail = within(a).getByText('Read result · Draft the agenda');
    fireEvent.click(detail);
    expect(detail.closest('details')?.open).toBe(true);
    expect(within(a).getByText('Actual scoped draft A.')).toBeTruthy();
    expect(within(a).getByText('HyperNeo’s response, not independently verified.')).toBeTruthy();
    expect(within(a).getByRole('button', { name: 'Copy work result' })).toBeTruthy();
    expect(within(b).queryByText(/Read result/)).toBeNull();
    expect(screen.queryByText('Checked state')).toBeNull();
  });
});

describe('Neo MVP controls', () => {
  it('keeps active A and queued B beside their human asks through stable promotion and settlement', async () => {
    const store = makeStore();
    store.sdkMessages.value = [
      { type: 'user', uuid: 'A', message: { content: 'Research status A' } },
      { type: 'user', uuid: 'B', message: { content: 'Research correction B' } },
      { type: 'user', uuid: 'C', message: { content: 'Unrelated math C' } },
      {
        type: 'assistant',
        uuid: 'reply-A',
        neoAskOrigin: { sessionId: 'neo', messageId: 'A' },
        message: { content: 'Older A acknowledgement' },
      },
      { type: 'result', uuid: 'result-A' },
    ] as unknown as ChatMessage[];
    const queued = {
      id: 'receipt-B',
      requestKey: 'B',
      concernId: 'research',
      originSessionId: 'neo',
      originMessageId: 'B',
      sessionId: 'holder-research',
      question: 'Actual queued correction B',
      status: 'queued' as const,
      createdAt: 2,
    };
    const source: NeoSnapshot = {
      ok: true,
      sessionId: 'neo',
      concerns: [
        {
          id: 'research',
          title: 'Research',
          summary: '',
          context: '',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      work: [],
      consultations: [
        { ...queued, id: 'receipt-A', originMessageId: 'A', status: 'pending', answer: null },
      ],
      consultationWaiters: [queued],
      askOrigins: ['A', 'B'].map((id) => ({
        kind: 'consultation',
        id: `receipt-${id}`,
        origin: { sessionId: 'neo', messageId: id },
      })),
    };
    const view = render(<NeoConversation store={store} sessionId="neo" snapshot={source} />);
    const a = screen.getByText('Research status A').closest('article')!;
    const b = screen.getByText('Research correction B').closest('article')!;
    const c = screen.getByText('Unrelated math C').closest('article')!;
    expect(within(a).getByRole('status').textContent).toBe('Checking Research’s context…');
    const waiting = within(b).getByRole('status');
    expect(waiting.textContent).toBe('Waiting for Research’s context…');
    expect(waiting.closest('.neo-message-bubble')).toBeNull();
    expect(waiting.querySelector('.neo-progress-dots')).toBeNull();
    expect(a.querySelector('.neo-progress-dots')).toBeTruthy();
    expect(within(c).queryByRole('status')).toBeNull();
    expect(
      within(screen.getByText('Older A acknowledgement').closest('article')!).queryByRole('status')
    ).toBeNull();
    expect(inventoryRequest).not.toHaveBeenCalled();
    fireEvent.click(within(b).getByText('How this is being handled'));
    const board = await within(b).findByRole('region', { name: 'Concern board' });
    await within(board).findByText(/Resource details captured/);
    expect(within(board).getByText('Waiting for context')).toBeTruthy();
    expect(within(board).getByText('Actual queued correction B')).toBeTruthy();
    expect(within(board).getByText('Receipt: receipt-B')).toBeTruthy();
    expect(within(board).queryByText('Receipt: receipt-A')).toBeNull();
    expect(within(board).queryByText('Handed to HyperNeo')).toBeNull();
    expect(within(board).getByText('holder-research')).toBeTruthy();
    const promoted: NeoSnapshot = {
      ...source,
      consultationWaiters: [],
      consultations: [{ ...queued, status: 'pending', answer: null }],
    };
    view.rerender(<NeoConversation store={store} sessionId="neo" snapshot={promoted} />);
    expect(within(b).getByText('Checking Research’s context…')).toBeTruthy();
    expect(within(b).queryByText('Waiting for Research’s context…')).toBeNull();
    expect(within(board).getByText('Checking context')).toBeTruthy();
    expect(within(board).getAllByText('Receipt: receipt-B')).toHaveLength(1);
    expect(within(a).queryByText('Checking Research’s context…')).toBeNull();
    view.rerender(
      <NeoConversation
        store={store}
        sessionId="neo"
        snapshot={{
          ...promoted,
          consultations: [{ ...queued, status: 'reported', answer: 'Correction saved.' }],
        }}
      />
    );
    expect(within(b).queryByText('Checking Research’s context…')).toBeNull();
    expect(within(board).getByText('Response ready')).toBeTruthy();
    expect(within(board).getByText('Correction saved.')).toBeTruthy();
    expect(within(c).queryByText('How this is being handled')).toBeNull();
  });

  it('opens A’s actual board under a delayed return without mixing in B’s same-concern work', async () => {
    const store = makeStore();
    store.sdkMessages.value = [
      { type: 'user', uuid: 'A', message: { content: 'Project request A' } },
      { type: 'user', uuid: 'B', message: { content: 'Project request B' } },
      {
        type: 'assistant',
        uuid: 'reply-B',
        neoAskOrigin: { sessionId: 'neo', messageId: 'B' },
        message: { content: 'B answer' },
      },
      { type: 'result', uuid: 'result-B' },
      {
        type: 'assistant',
        uuid: 'reply-A',
        neoAskOrigin: { sessionId: 'neo', messageId: 'A' },
        message: { content: 'Late A answer' },
      },
      { type: 'result', uuid: 'result-A' },
      { type: 'assistant', uuid: 'legacy', message: { content: 'Unattributed answer' } },
      { type: 'result', uuid: 'legacy-result' },
    ] as unknown as ChatMessage[];
    const snapshot: NeoSnapshot = {
      ok: true,
      sessionId: 'neo',
      concerns: [],
      consultations: [],
      work: ['A', 'B'].map((id) => ({
        ...work,
        id,
        title: `Actual work ${id}`,
        status: 'queued',
        originMessageId: id,
        sessionId: `worker-${id}`,
      })),
      askOrigins: ['A', 'B'].map((id) => ({
        kind: 'work',
        id,
        origin: { sessionId: 'neo', messageId: id },
      })),
    };
    render(<NeoConversation store={store} sessionId="neo" snapshot={snapshot} />);
    const a = screen.getByText('Late A answer').closest('article')!;
    const b = screen.getByText('B answer').closest('article')!;
    expect(inventoryRequest).not.toHaveBeenCalled();
    expect(within(b).getByText('How this is being handled')).toBeTruthy();
    expect(
      within(screen.getByText('Unattributed answer').closest('article')!).queryByText(
        'How this is being handled'
      )
    ).toBeNull();
    expect(
      within(screen.getByText('Project request A').closest('article')!).getByText(
        'How this is being handled'
      )
    ).toBeTruthy();
    fireEvent.click(within(a).getByText('How this is being handled'));
    await waitFor(() => expect(inventoryRequest).toHaveBeenCalledTimes(1));
    expect(within(a).getByText('Actual work A')).toBeTruthy();
    expect(within(a).queryByText('Actual work B')).toBeNull();
    expect(within(a).getByText('worker-A')).toBeTruthy();
    expect(within(a).queryByText('worker-B')).toBeNull();
    expect(within(a).getByRole('button', { name: 'Copy Neo’s message' })).toBeTruthy();
    expect(within(a).queryByRole('link')).toBeNull();
    fireEvent.click(within(a).getByRole('button', { name: 'Close board' }));
    await waitFor(() =>
      expect(within(a).queryByRole('region', { name: 'Concern board' })).toBeNull()
    );
    expect(screen.getByText('Project request B')).toBeTruthy();
  });
  it('ties late A to its actual request while B stays direct and clicking remains in this view', () => {
    const store = makeStore();
    const human = (uuid: string, text: string) => ({
      type: 'user',
      uuid,
      session_id: 'neo',
      message: { role: 'user', content: text },
    });
    const answer = (uuid: string, text: string, messageId: string) => ({
      type: 'assistant',
      uuid,
      neoAskOrigin: { sessionId: 'neo', messageId },
      message: { role: 'assistant', content: text },
    });
    store.sdkMessages.value = [
      human('A', 'Review the project draft'),
      human('B', 'When is dinner?'),
      answer('reply-B', 'Dinner is at seven.', 'B'),
      { type: 'result', uuid: 'result-B' },
      { type: 'user', uuid: 'work', inputKind: 'system', message: { content: 'Internal report' } },
      answer('reply-A', 'The draft is ready.', 'A'),
      { type: 'result', uuid: 'result-A' },
    ] as unknown as SessionStore['sdkMessages']['value'];
    render(<NeoConversation store={store} sessionId="neo" />);
    const target = document.getElementById(neoMessageAnchor('neo', 'A'))!;
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    const a = screen.getByText('The draft is ready.').closest('article')!;
    const b = screen.getByText('Dinner is at seven.').closest('article')!;
    fireEvent.click(
      within(a).getByRole('button', { name: 'Return to your request: Review the project draft' })
    );
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    expect(within(b).queryByRole('button', { name: /Return to your request/ })).toBeNull();
    expect(within(a).getByRole('button', { name: 'Copy Neo’s message' })).toBeTruthy();
    expect(screen.queryByText('Internal report')).toBeNull();
    expect(
      screen.getByRole('region', { name: 'Conversation with Neo' }).querySelectorAll('article')[0]
    ).toBe(target);
  });
  it.each([
    null,
    undefined,
    { sessionId: 'other', messageId: 'A' },
    { sessionId: 'neo', messageId: 'missing' },
  ])('never labels an unknown late reply using the latest human ask: %j', (neoAskOrigin) => {
    const store = makeStore();
    store.sdkMessages.value = [
      { type: 'user', uuid: 'A', message: { content: 'Original request' } },
      { type: 'user', uuid: 'B', message: { content: 'Latest unrelated request' } },
      {
        type: 'assistant',
        uuid: 'answer',
        neoAskOrigin,
        message: { content: 'Unattributed answer' },
      },
      { type: 'result', uuid: 'result' },
    ] as unknown as SessionStore['sdkMessages']['value'];
    render(<NeoConversation store={store} sessionId="neo" />);
    expect(screen.queryByRole('button', { name: /Return to your request/ })).toBeNull();
    expect(screen.getByText('Unattributed answer')).toBeTruthy();
  });
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
  it('describes existing-chat execution and closes only the wait for its shared result', () => {
    const action = vi.fn();
    const view = render(
      <NeoWorkCard
        work={{ ...work, targetSessionId: 'project-chat' }}
        busy={false}
        disabled={false}
        onAction={action}
      />
    );
    expect(screen.getByText(/selected existing HyperNeo chat/)).toBeTruthy();
    expect(screen.queryByText(/temporary scratch workspace/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }));
    expect(action).toHaveBeenCalledWith(work.id, 'start');
    view.rerender(
      <NeoWorkCard
        work={{
          ...work,
          targetSessionId: 'project-chat',
          sessionId: 'project-chat',
          status: 'queued',
        }}
        busy={false}
        disabled={false}
        onAction={action}
      />
    );
    expect(screen.queryByRole('button', { name: 'Stop work' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(action).toHaveBeenCalledWith(work.id, 'cancel');
    view.rerender(
      <NeoWorkCard
        work={{
          ...work,
          targetSessionId: 'project-chat',
          sessionId: 'project-chat',
          status: 'cancelled',
        }}
        busy={false}
        disabled={false}
        onAction={action}
      />
    );
    expect(screen.getByText(/existing chat and its other work continue/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
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
    expect(within(conversation).queryByRole('button', { name: 'What happened' })).toBeNull();
    expect(within(conversation).queryByText('How this is being handled')).toBeNull();
    expect(within(conversation).queryByRole('link', { name: /technical trace/ })).toBeNull();
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
  it('keeps direct replies copyable without a legacy activity or technical-trace fallback', () => {
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
    expect(within(reply).queryByRole('button', { name: 'What happened' })).toBeNull();
    expect(within(reply).queryByRole('link', { name: /technical trace/ })).toBeNull();
    expect(within(reply).queryByText('How this is being handled')).toBeNull();
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
