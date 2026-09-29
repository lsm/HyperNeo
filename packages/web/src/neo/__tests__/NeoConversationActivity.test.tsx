import { act, cleanup, render, screen, within } from '@testing-library/preact';
import { computed, signal } from '@preact/signals';
import type { AgentProcessingState, ChatMessage, SessionState } from '@hyperneo/shared';
import type { SessionStore } from '../../lib/session-store.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoConversation } from '../NeoConversation.tsx';

const connected = vi.hoisted(() => ({ value: 'connected' }));
vi.mock('../../lib/state.ts', () => ({ connectionState: connected }));
vi.mock('../../components/chat/MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('../../components/QuestionPrompt.tsx', () => ({ QuestionPrompt: () => null }));

function state(agentState: AgentProcessingState): SessionState {
  return {
    sessionInfo: { id: 'neo' },
    agentState,
    commandsData: { availableCommands: [] },
    error: null,
    timestamp: 1,
  } as unknown as SessionState;
}

function ask(uuid: string, text: string): ChatMessage {
  return {
    type: 'user',
    uuid,
    session_id: 'neo',
    parent_tool_use_id: null,
    inputKind: 'human',
    message: { role: 'user', content: text },
  } as unknown as ChatMessage;
}

function makeStore() {
  const sessionState = signal<SessionState | null>(
    state({ status: 'processing', messageId: 'ask-A', phase: 'thinking' })
  );
  const store = {
    activeSessionId: signal<string | null>('neo'),
    agentState: computed(() => sessionState.value?.agentState ?? { status: 'idle' }),
    error: computed(() => sessionState.value?.error ?? null),
    hasMoreMessages: signal(false),
    isRecovering: signal(false),
    refresh: vi.fn(),
    sdkMessages: signal([ask('ask-A', 'First request'), ask('ask-B', 'Second request')]),
    sessionState,
  } as unknown as SessionStore;
  return { store, sessionState };
}

afterEach(cleanup);

describe('NeoConversation processing activity', () => {
  it('moves one quiet status from A to B with native input state and no global duplicate', async () => {
    const { store, sessionState } = makeStore();
    const view = render(<NeoConversation store={store} sessionId="neo" />);
    const conversation = screen.getByRole('region', { name: 'Conversation with Neo' });
    const a = screen.getByText('First request').closest('article')!;
    const b = screen.getByText('Second request').closest('article')!;

    expect(within(a).getByRole('status').textContent).toContain('Neo is working on a reply');
    expect(within(b).queryByRole('status')).toBeNull();
    expect(within(conversation).getAllByRole('status')).toHaveLength(1);

    await act(() => {
      sessionState.value = state({ status: 'queued', messageId: 'ask-B' });
    });
    view.rerender(<NeoConversation store={store} sessionId="neo" />);

    expect(within(a).queryByRole('status')).toBeNull();
    expect(within(b).getByRole('status').textContent).toContain('Neo is getting ready');
    expect(within(conversation).getAllByRole('status')).toHaveLength(1);
  });
});
