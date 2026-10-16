import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoComposer } from '../NeoComposer.tsx';
import { NeoConversation } from '../NeoConversation.tsx';
import { testCard } from './neo-test-views.ts';
import { NeoWorkCard } from '../NeoWorkCard.tsx';

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
  projectId: null,
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
  it('proposals show their brief without work-card decision buttons', () => {
    const action = vi.fn();
    render(
      <NeoWorkCard
        work={work}
        card={testCard(work)}
        busy={false}
        disabled={false}
        onAction={action}
      />
    );
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByText(work.instruction)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start work' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });
  it('shows no work-card decision controls while busy and leaves reports to the work chat', () => {
    const action = vi.fn();
    const view = render(
      <NeoWorkCard work={work} card={testCard(work)} busy disabled={false} onAction={action} />
    );
    expect(screen.queryByRole('button', { name: 'Starting…' })).toBeNull();
    expect(action).not.toHaveBeenCalled();
    view.rerender(
      <NeoWorkCard
        work={{
          ...work,
          status: 'reported',
          sessionId: 'worker-one',
          report: 'A draft, not a booking.',
        }}
        card={testCard({
          ...work,
          status: 'reported',
          sessionId: 'worker-one',
          report: 'A draft, not a booking.',
        })}
        busy={false}
        disabled={false}
        onAction={action}
      />
    );
    expect(screen.getByText('Reply received')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start work' })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('A draft, not a booking.')).toBeNull();
  });
  it('shows existing-chat work status with stop only in its menu', () => {
    const action = vi.fn();
    const view = render(
      <NeoWorkCard
        work={{ ...work, targetSessionId: 'project-chat' }}
        card={testCard({ ...work, targetSessionId: 'project-chat' })}
        busy={false}
        disabled={false}
        onAction={action}
      />
    );
    expect(screen.queryByRole('button', { name: 'Start work' })).toBeNull();
    view.rerender(
      <NeoWorkCard
        work={{
          ...work,
          targetSessionId: 'project-chat',
          sessionId: 'project-chat',
          status: 'queued',
        }}
        card={testCard({
          ...work,
          targetSessionId: 'project-chat',
          sessionId: 'project-chat',
          status: 'queued',
        })}
        busy={false}
        disabled={false}
        onAction={action}
      />
    );
    expect(screen.getByText('Handed to HyperNeo')).toBeTruthy();
    expect(
      screen.queryAllByRole('button').map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Card actions']);
    expect(action).not.toHaveBeenCalled();
    view.rerender(
      <NeoWorkCard
        work={{
          ...work,
          targetSessionId: 'project-chat',
          sessionId: 'project-chat',
          status: 'cancelled',
        }}
        card={testCard({
          ...work,
          targetSessionId: 'project-chat',
          sessionId: 'project-chat',
          status: 'cancelled',
        })}
        busy={false}
        disabled={false}
        onAction={action}
      />
    );
    expect(screen.getByText('Stopped')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
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
  it('sends through the supplied durable intake client without creating a project', async () => {
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
    expect(onDraft).not.toHaveBeenCalled();
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
