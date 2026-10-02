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
