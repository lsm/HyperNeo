import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Session } from '@hyperneo/shared';

const mockSessionInfo = signal<Session | null>(null);
const mockSdkMessages = signal<ChatMessage[]>([]);
const mockBackgroundMessages = signal<ChatMessage[]>([]);
const mockAgents = signal<Array<Record<string, unknown>>>([]);
const mockSpace = signal<{ slug: string } | null>(null);
const mockNavigateToSpaceAgent = vi.fn();

vi.mock('../../lib/session-store', () => ({
  sessionStore: {
    get sessionInfo() {
      return mockSessionInfo;
    },
    get sdkMessages() {
      return mockSdkMessages;
    },
    get backgroundTaskMessages() {
      return mockBackgroundMessages;
    },
  },
}));
vi.mock('../../lib/space-store', () => ({
  spaceStore: {
    get agents() {
      return mockAgents;
    },
    get space() {
      return mockSpace;
    },
  },
}));
vi.mock('../../lib/router', () => ({
  navigateToSpaceAgent: (...args: unknown[]) => mockNavigateToSpaceAgent(...args),
}));
vi.mock('../../components/GitPanel', () => ({
  GitPanel: (props: { sessionId: string }) => (
    <div data-testid="git-panel" data-session-id={props.sessionId} />
  ),
}));
vi.mock('../../hooks/useSessionRename', () => ({
  useSessionRename: () => ({
    isEditing: false,
    startEditing: vi.fn(),
    commit: vi.fn(),
    inputProps: {},
  }),
}));

import { rightPanelTargetSignal } from '../../lib/signals';
import { connectionState } from '../../lib/state';
import {
  SessionInspector,
  collectToolInputs,
  extractLatestTodos,
  formatDate,
} from '../SessionInspector';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'My chat',
    status: 'active',
    workspacePath: '/repo',
    createdAt: '2026-09-25T00:00:00.000Z',
    lastActiveAt: '2026-09-25T00:00:00.000Z',
    config: { model: 'sonnet' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    ...overrides,
  } as Session;
}

describe('SessionInspector', () => {
  beforeEach(() => {
    connectionState.value = 'connected';
    mockSessionInfo.value = session();
    mockSdkMessages.value = [];
    mockBackgroundMessages.value = [];
    mockAgents.value = [];
    mockSpace.value = null;
    rightPanelTargetSignal.value = { type: 'inspector', sessionId: 's1' };
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the session card with model and workspace for a plain chat', () => {
    render(<SessionInspector sessionId="s1" />);
    const card = screen.getByTestId('inspector-session-card');
    expect(card.textContent).toContain('My chat');
    expect(card.textContent).toContain('sonnet');
    expect(card.textContent).toContain('/repo');
    expect(screen.getByTitle('Rename session')).toBeTruthy();
  });

  it('shows the agent card instead for an agent-owned session', () => {
    mockAgents.value = [
      {
        id: 'a1',
        sessionId: 's1',
        displayName: 'Scout',
        handle: 'scout',
        status: 'active',
        instructions: 'Look around',
      },
    ];
    mockSpace.value = { slug: 'my-space' };
    render(<SessionInspector sessionId="s1" />);
    const card = screen.getByTestId('inspector-agent-card');
    expect(card.textContent).toContain('Scout');
    expect(card.textContent).toContain('@scout');
    expect(card.textContent).toContain('Look around');
    expect(screen.queryByTitle('Rename session')).toBeNull();
    fireEvent.click(screen.getByTestId('inspector-open-agent'));
    expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('my-space', 'scout');
  });

  it('shows recorded progress under Work and falls back to TodoWrite messages', () => {
    mockSessionInfo.value = session({
      metadata: {
        ...session().metadata,
        progress: {
          source: 'task',
          updatedAt: 'x',
          items: [{ id: 'task:1', content: 'Recorded', status: 'in_progress' }],
        },
      } as Session['metadata'],
    });
    render(<SessionInspector sessionId="s1" section="work" />);
    expect(screen.getByTestId('inspector-progress').textContent).toContain('Recorded');

    const messages = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TodoWrite',
              input: { todos: [{ content: 'Parsed', status: 'pending' }] },
            },
          ],
        },
      },
    ] as unknown as ChatMessage[];
    expect(extractLatestTodos(messages)).toEqual([
      { id: 'todo:0', content: 'Parsed', status: 'pending' },
    ]);
  });

  it('switches tabs, renders the git panel under Changes, and closes', () => {
    render(<SessionInspector sessionId="s1" />);
    fireEvent.click(screen.getByTestId('inspector-tab-changes'));
    expect(screen.getByTestId('git-panel').getAttribute('data-session-id')).toBe('s1');
    fireEvent.click(screen.getByTestId('inspector-close'));
    expect(rightPanelTargetSignal.value).toBeNull();
  });

  it('disables Changes for a session without a workspace', () => {
    mockSessionInfo.value = session({ workspacePath: null });
    render(<SessionInspector sessionId="s1" />);
    expect((screen.getByTestId('inspector-tab-changes') as HTMLButtonElement).disabled).toBe(true);
  });

  it('labels background tasks with the tool command from the loaded messages', () => {
    mockSdkMessages.value = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'bun test' } },
          ],
        },
      },
    ] as unknown as ChatMessage[];
    mockBackgroundMessages.value = [
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        description: 'Run tests',
      },
    ] as unknown as ChatMessage[];
    render(<SessionInspector sessionId="s1" section="work" />);

    expect(screen.getByTestId('inspector-background-tasks').textContent).toContain('bun test');
    expect(collectToolInputs(mockSdkMessages.value).get('tool-1')).toEqual({ command: 'bun test' });
  });

  it('formatDate returns undefined for a missing date', () => {
    expect(formatDate(undefined)).toBeUndefined();
    expect(formatDate('2026-09-25T00:00:00.000Z')).toBeTruthy();
  });
});
