import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveTurnSummary } from '@hyperneo/shared';
import { parseThreadRow } from '../space-task-thread-events';
import { MinimalThreadFeed } from './MinimalThreadFeed';

const mockPushOverlayHistory = vi.hoisted(() => vi.fn());

vi.mock('../../../chat/MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

vi.mock('../../../../lib/router', () => ({
  pushOverlayHistory: mockPushOverlayHistory,
}));

function makeRow(opts: {
  id: string;
  label: string;
  createdAt: number;
  message: unknown;
  sessionId?: string;
  kind?: 'task_agent' | 'node_agent';
  role?: string;
  origin?: string | null;
  turnIndex?: number;
  nodeExecutionId?: string | null;
  messageType?: string;
}) {
  return parseThreadRow({
    id: opts.id,
    sessionId: opts.sessionId ?? 'space:s:task:t',
    kind: opts.kind ?? 'task_agent',
    role: opts.role ?? 'task',
    nodeExecutionId: opts.nodeExecutionId,
    label: opts.label,
    taskId: 't',
    taskTitle: 'Task',
    messageType: opts.messageType ?? 'assistant',
    content: JSON.stringify(opts.message),
    createdAt: opts.createdAt,
    origin: opts.origin,
    turnIndex: opts.turnIndex,
  });
}

function assistantText(uuid: string, text: string) {
  return {
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text }] },
  };
}

function assistantError(uuid: string, text: string, error = 'invalid_request') {
  return {
    type: 'assistant',
    uuid,
    error,
    message: { content: [{ type: 'text', text }] },
  };
}

function assistantToolUse(
  uuid: string,
  tools: Array<{ name: string; input: Record<string, unknown> }>
) {
  return {
    type: 'assistant',
    uuid,
    message: {
      content: tools.map((t, i) => ({
        type: 'tool_use',
        id: `tu-${uuid}-${i}`,
        name: t.name,
        input: t.input,
      })),
    },
  };
}

function resultMessage(uuid: string, result = '') {
  return {
    type: 'result',
    uuid,
    subtype: 'success',
    result,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function humanUserMessage(uuid: string, text: string) {
  return {
    type: 'user',
    uuid,
    message: { content: text },
  };
}

function syntheticPeerMessage(
  uuid: string,
  text: string,
  from: { name?: string; sessionId?: string }
) {
  return {
    type: 'user',
    uuid,
    isSynthetic: true,
    origin: { kind: 'peer', from: from.sessionId ?? 'session-x', name: from.name },
    message: { content: [{ type: 'text', text }] },
  };
}

function replayUserMessage(uuid: string, text: string) {
  return {
    type: 'user',
    uuid,
    isReplay: true,
    message: { content: text },
  };
}

function compactBoundaryMessage(
  uuid: string,
  metadata: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;
    post_tokens?: number;
    duration_ms?: number;
  }
) {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid,
    session_id: 'test-session',
    compact_metadata: metadata,
  };
}

function operationalSystemMessage(
  uuid: string,
  subtype:
    | 'thinking_tokens'
    | 'session_state_changed'
    | 'commands_changed'
    | 'model_refusal_fallback'
    | 'informational'
    | 'worker_shutting_down',
  fields: Record<string, unknown>
) {
  return {
    type: 'system',
    subtype,
    uuid,
    session_id: 'test-session',
    ...fields,
  };
}

function systemInitMessage(uuid: string) {
  return {
    type: 'system',
    subtype: 'init',
    uuid,
    session_id: 'test-session',
    model: 'claude-3-5-sonnet-20241022',
    cwd: '/tmp',
    tools: ['Read', 'Bash'],
    mcp_servers: [],
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    agents: [],
    apiKeySource: 'user',
    betas: [],
    claude_code_version: '1.2.3',
  };
}

function errorResultMessage(uuid: string) {
  return {
    type: 'result',
    uuid,
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: 1,
    errors: ['something failed'],
    stop_reason: null,
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 50,
      output_tokens: 25,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

function budgetErrorResultMessage(uuid: string) {
  return {
    type: 'result',
    uuid,
    subtype: 'error_max_budget_usd',
    is_error: true,
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: 1,
    errors: ['Budget limit exceeded'],
    stop_reason: null,
    total_cost_usd: 0.5,
    usage: { input_tokens: 50, output_tokens: 25 },
  };
}

function errorResultMessageWithEmptyErrors(uuid: string) {
  return {
    type: 'result',
    uuid,
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: 1,
    errors: [],
    stop_reason: null,
    total_cost_usd: 0.001,
    usage: { input_tokens: 50, output_tokens: 25 },
  };
}

function statusMessage(uuid: string, status: 'compacting' | 'requesting', sessionId?: string) {
  return {
    type: 'system',
    subtype: 'status',
    uuid,
    session_id: sessionId ?? 'space:s:task:t',
    status,
  };
}

function statusClearMessage(uuid: string, sessionId?: string) {
  return {
    type: 'system',
    subtype: 'status',
    uuid,
    session_id: sessionId ?? 'space:s:task:t',
    status: null,
  };
}

describe('MinimalThreadFeed', () => {
  beforeEach(() => {
    cleanup();
    mockPushOverlayHistory.mockClear();
  });
  afterEach(() => cleanup());

  it('renders nothing when there are no rows', () => {
    const { container } = render(<MinimalThreadFeed parsedRows={[]} />);
    expect(container.querySelector('[data-testid="space-task-event-feed-minimal"]')).toBeNull();
  });

  it('renders compact boundary rows with trigger and token counts', () => {
    const baseTime = new Date('2026-04-25T18:00:00Z').getTime();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: baseTime,
        message: assistantText('a1', 'before compaction'),
      }),
      makeRow({
        id: 'c1',
        label: 'Coder Agent',
        createdAt: baseTime + 1000,
        message: compactBoundaryMessage('c1', {
          trigger: 'auto',
          pre_tokens: 125000,
          post_tokens: 24000,
          duration_ms: 2100,
        }),
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: baseTime + 2000,
        message: assistantText('a2', 'after compaction'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    const compactBoundary = screen.getByTestId('minimal-thread-compact-boundary');
    expect(compactBoundary.textContent).toContain('Compact Boundary');
    expect(compactBoundary.textContent).toContain('auto');
    expect(compactBoundary.textContent).toContain('125,000 → 24,000 tokens');
    expect(compactBoundary.textContent).toContain('saved 101,000');
    expect(screen.getByText('before compaction')).not.toBeNull();
    expect(screen.getByText('after compaction')).not.toBeNull();
  });

  it('renders operational system rows in compact task feeds', () => {
    const baseTime = new Date('2026-04-25T18:00:00Z').getTime();
    const rows = [
      makeRow({
        id: 'thinking',
        label: 'Coder Agent',
        createdAt: baseTime,
        message: operationalSystemMessage('thinking-uuid', 'thinking_tokens', {
          estimated_tokens: 1250,
          estimated_tokens_delta: 25,
        }),
      }),
      makeRow({
        id: 'state',
        label: 'Coder Agent',
        createdAt: baseTime + 1000,
        message: operationalSystemMessage('state-uuid', 'session_state_changed', {
          state: 'running',
        }),
      }),
      makeRow({
        id: 'commands',
        label: 'Coder Agent',
        createdAt: baseTime + 2000,
        message: operationalSystemMessage('commands-uuid', 'commands_changed', {
          commands: [{ name: 'review' }, { name: 'test' }],
        }),
      }),
      makeRow({
        id: 'fallback',
        label: 'Coder Agent',
        createdAt: baseTime + 3000,
        message: operationalSystemMessage('fallback-uuid', 'model_refusal_fallback', {
          content: 'Retried with fallback model',
          original_model: 'claude-opus-4-5',
          fallback_model: 'claude-sonnet-4-5',
        }),
      }),
      makeRow({
        id: 'notice',
        label: 'Coder Agent',
        createdAt: baseTime + 4000,
        message: operationalSystemMessage('notice-uuid', 'informational', {
          level: 'warning',
          content: 'Hook warning shown to the user',
        }),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    const systemRows = screen.getAllByTestId('minimal-thread-system');
    expect(systemRows).toHaveLength(2);
    expect(systemRows[0].textContent).toContain('Model fallback');
    expect(systemRows[0].textContent).toContain('Retried with fallback model');
    expect(systemRows[0].textContent).toContain('claude-opus-4-5 -> claude-sonnet-4-5');
    expect(systemRows[1].textContent).toContain('Warning');
    expect(systemRows[1].textContent).toContain('Hook warning shown to the user');
    expect(screen.getByTestId('space-task-event-feed-minimal').textContent).not.toContain(
      'Thinking tokens'
    );
  });

  it('renders worker shutdown rows only at the session tail', () => {
    const baseTime = new Date('2026-04-25T18:00:00Z').getTime();
    const rows = [
      makeRow({
        id: 'stale-shutdown',
        label: 'Coder Agent',
        createdAt: baseTime,
        message: operationalSystemMessage('stale-shutdown-uuid', 'worker_shutting_down', {
          reason: 'host_exit',
        }),
      }),
      makeRow({
        id: 'newer-work',
        label: 'Coder Agent',
        createdAt: baseTime + 1000,
        message: assistantText('newer-work-uuid', 'continued work'),
      }),
      makeRow({
        id: 'tail-shutdown',
        label: 'Reviewer Agent',
        sessionId: 'reviewer-session',
        createdAt: baseTime + 2000,
        message: operationalSystemMessage('tail-shutdown-uuid', 'worker_shutting_down', {
          reason: 'host_exit',
        }),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    expect(screen.queryByText('continued work')).not.toBeNull();
    const systemRows = screen.getAllByTestId('minimal-thread-system');
    expect(systemRows).toHaveLength(1);
    expect(systemRows[0].textContent).toContain('Worker Shutting Down');
    expect(systemRows[0].textContent).toContain('host_exit');
  });

  it('renders one turn row per agent block with name and clock', () => {
    const baseTime = new Date('2026-04-25T18:00:00Z').getTime();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: baseTime,
        message: assistantText('a1', 'first'),
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: baseTime + 1000,
        message: resultMessage('r1'),
      }),
      makeRow({
        id: 'a2',
        label: 'Reviewer Agent',
        createdAt: baseTime + 5000,
        message: assistantText('a2', 'looks good'),
      }),
      makeRow({
        id: 'r2',
        label: 'Reviewer Agent',
        createdAt: baseTime + 6000,
        message: resultMessage('r2'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);
    const turns = screen.getAllByTestId('minimal-thread-turn');
    expect(turns.length).toBe(2);
    expect(turns[0].dataset.agentLabel).toBe('Coder Agent');
    expect(turns[1].dataset.agentLabel).toBe('Reviewer Agent');
    expect(turns[0].textContent).toContain('CODER');
    expect(turns[1].textContent).toContain('REVIEWER');
    expect(turns.every((t) => t.dataset.turnState === 'completed')).toBe(true);
  });

  it('opens the completed agent session from the avatar/name header with a highlight target', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantText('a1', 'done'),
        sessionId: 'session-completed',
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: resultMessage('r1'),
        sessionId: 'session-completed',
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);
    const trigger = screen.getByTestId('minimal-thread-agent-open');
    expect(trigger.className).toContain('min-h-11');
    fireEvent.click(trigger);
    expect(mockPushOverlayHistory).toHaveBeenCalledWith('session-completed', 'Coder Agent', 'a1');
  });

  it('opens the running agent session from the avatar/name header without requiring a highlight target', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
        sessionId: 'session-active',
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);
    const trigger = screen.getByTestId('minimal-thread-agent-open');
    expect(trigger.getAttribute('aria-label')).toBe('Open Coder Agent session');
    fireEvent.click(trigger);
    expect(mockPushOverlayHistory).toHaveBeenCalledWith('session-active', 'Coder Agent', undefined);
  });

  it('adds task context only for node-agent overlay opens from the feed', () => {
    const t = Date.now();
    const nodeRows = [
      makeRow({
        id: 'node-a1',
        label: 'Coder Agent',
        kind: 'node_agent',
        role: 'coder',
        nodeExecutionId: 'exec-coder-1',
        createdAt: t,
        message: assistantText('node-a1', 'done'),
        sessionId: 'session-node',
      }),
    ];
    const taskRows = [
      makeRow({
        id: 'task-a1',
        label: 'Task Agent',
        kind: 'task_agent',
        role: 'task',
        createdAt: t,
        message: assistantText('task-a1', 'done'),
        sessionId: 'session-task',
      }),
    ];

    const { unmount } = render(<MinimalThreadFeed parsedRows={nodeRows} overlayTaskId="task-1" />);
    fireEvent.click(screen.getByTestId('minimal-thread-agent-open'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith('session-node', 'Coder Agent', 'node-a1', {
      taskId: 'task-1',
      agentName: 'coder',
      nodeExecutionId: 'exec-coder-1',
    });

    unmount();
    mockPushOverlayHistory.mockClear();
    render(<MinimalThreadFeed parsedRows={taskRows} overlayTaskId="task-1" />);
    fireEvent.click(screen.getByTestId('minimal-thread-agent-open'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith('session-task', 'Task Agent', 'task-a1');
  });

  it('opens node-agent feed turns read-only when the task overlay is marked read-only', () => {
    const t = Date.now();
    const nodeRows = [
      makeRow({
        id: 'node-ro-1',
        label: 'Coder Agent',
        kind: 'node_agent',
        role: 'coder',
        nodeExecutionId: 'exec-coder-ro',
        createdAt: t,
        message: assistantText('node-ro-1', 'done'),
        sessionId: 'session-node-ro',
      }),
    ];

    const { unmount } = render(
      <MinimalThreadFeed parsedRows={nodeRows} overlayTaskId="task-1" overlayTaskReadonly />
    );
    fireEvent.click(screen.getByTestId('minimal-thread-agent-open'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith(
      'session-node-ro',
      'Coder Agent',
      'node-ro-1',
      {
        taskId: 'task-1',
        agentName: 'coder',
        sessionId: 'session-node-ro',
        readonly: true,
      }
    );

    unmount();
    mockPushOverlayHistory.mockClear();
    const taskRows = [
      makeRow({
        id: 'task-ro-1',
        label: 'Task Agent',
        kind: 'task_agent',
        role: 'task',
        createdAt: t,
        message: assistantText('task-ro-1', 'done'),
        sessionId: 'session-task-ro',
      }),
    ];
    render(<MinimalThreadFeed parsedRows={taskRows} overlayTaskId="task-1" overlayTaskReadonly />);
    fireEvent.click(screen.getByTestId('minimal-thread-agent-open'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith(
      'session-task-ro',
      'Task Agent',
      'task-ro-1',
      {
        taskId: 'task-1',
        agentName: 'task',
        sessionId: 'session-task-ro',
        readonly: true,
      }
    );
    expect(screen.getByTestId('minimal-thread-agent-open').getAttribute('title')).toBe(
      'Opens read-only — resume the task to chat'
    );
    expect(screen.getAllByTitle('Opens read-only — resume the task to chat')).toHaveLength(2);
    expect(
      screen
        .getAllByTitle('Opens read-only — resume the task to chat')
        .every((el) => el.getAttribute('aria-label')?.includes('read-only'))
    ).toBe(true);
  });

  it('renders the last assistant text of a completed block as its message body', async () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantText('a1', 'preliminary'),
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: assistantText('a2', 'final answer ready'),
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 2000,
        message: resultMessage('r1'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);
    await waitFor(() => {
      expect(screen.getByText('final answer ready')).toBeTruthy();
    });
    expect(screen.queryByText('preliminary')).toBeNull();
  });

  it('renders an assistant error message as a red error bubble (not gray)', async () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantError(
          'a1',
          'API Error: 400 {"type":"invalid_request_error","message":"messages must alternate"}'
        ),
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: resultMessage('r1'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);
    const bubble = screen.getByTestId('minimal-thread-agent-bubble');
    expect(bubble.getAttribute('data-has-error')).toBe('true');
    expect(bubble.className).toContain('border-red-800');
    expect(bubble.className).toContain('bg-red-900');
    expect(bubble.className).not.toContain('bg-dark-800');
    expect(bubble.textContent).toContain('API Error');
    await waitFor(() => {
      expect(screen.getByTestId('md').textContent).toContain('API Error: 400');
    });
  });

  it('renders a normal assistant reply without error styling', async () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantText('a1', 'all good'),
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: resultMessage('r1'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);
    const bubble = screen.getByTestId('minimal-thread-agent-bubble');
    expect(bubble.getAttribute('data-has-error')).toBeNull();
    expect(bubble.className).not.toContain('border-red');
    expect(bubble.className).toContain('bg-dark-800');
    expect(bubble.textContent).not.toContain('API Error');
    await waitFor(() => {
      expect(screen.getByText('all good')).toBeTruthy();
    });
  });

  it('renders a recovered turn (error then success) as a gray bubble, not red', async () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'err',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantError('err', 'API Error: 429 overloaded', 'overloaded_error'),
      }),
      makeRow({
        id: 'ok',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: assistantText('ok', 'Recovered — here is the fix'),
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 2000,
        message: resultMessage('r1'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);
    const bubble = screen.getByTestId('minimal-thread-agent-bubble');
    expect(bubble.getAttribute('data-has-error')).toBeNull();
    expect(bubble.className).toContain('bg-dark-800');
    expect(bubble.className).not.toContain('border-red');
    await waitFor(() => {
      expect(screen.getByText('Recovered — here is the fix')).toBeTruthy();
    });
  });

  it('keeps folded post-result task_notification rows from creating active rails', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 100,
        message: resultMessage('r1', 'Done'),
      }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 200,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'completed',
          summary: 'all green',
          output_file: '/tmp/o',
        },
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);

    const turn = screen.getByTestId('minimal-thread-turn');
    expect(turn.dataset.turnState).toBe('completed');
    expect(screen.queryByTestId('minimal-thread-active-rail')).toBeNull();
    expect(screen.queryByText('Task completed')).toBeNull();
    const entry = screen.getByTestId('minimal-thread-roster-entry');
    expect(entry.dataset.taskStatus).toBe('completed');
    expect(entry.textContent).toContain('all green');
  });

  it('mirrors hidden row handling when collecting completed roster targets', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 's1',
        label: 'Coder Agent',
        createdAt: t + 50,
        messageType: 'system',
        message: { type: 'system', subtype: 'task_started', uuid: 's1' },
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 100,
        message: assistantText('a2', 'Done'),
      }),
      makeRow({ id: 'r1', label: 'Coder Agent', createdAt: t + 200, message: resultMessage('r1') }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 300,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'completed',
          summary: 'no duplicate row',
          output_file: '/tmp/o',
        },
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    expect(screen.queryByText('Task completed')).toBeNull();
    const entry = screen.getByTestId('minimal-thread-roster-entry');
    expect(entry.dataset.taskStatus).toBe('completed');
    expect(entry.textContent).toContain('no duplicate row');
  });

  it('folds task_notification onto an earlier completed segment in a user-interrupted block', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 100,
        message: assistantText('a2', 'First segment done'),
      }),
      makeRow({
        id: 'u1',
        label: 'Coder Agent',
        createdAt: t + 200,
        message: humanUserMessage('u1', 'continue'),
        messageType: 'user',
      }),
      makeRow({
        id: 'a3',
        label: 'Coder Agent',
        createdAt: t + 300,
        message: assistantText('a3', 'Final answer'),
      }),
      makeRow({ id: 'r1', label: 'Coder Agent', createdAt: t + 400, message: resultMessage('r1') }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 500,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'completed',
          summary: 'early tool passed',
          output_file: '/tmp/o',
        },
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    expect(screen.queryByText('Task completed')).toBeNull();
    const entry = screen.getByTestId('minimal-thread-roster-entry');
    expect(entry.dataset.taskStatus).toBe('completed');
    expect(entry.textContent).toContain('early tool passed');
    expect(entry.textContent).toContain('✓');
  });

  it('keeps earlier completed slices when api_retry appears in the active tail', () => {
    const t = Date.now();
    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        {
          kind: 'api_retry',
          attempt: 1,
          maxRetries: 3,
          retryDelayMs: 1000,
          errorStatus: 529,
          ts: t + 350,
          uuid: 'retry1',
        },
      ],
    };
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        turnIndex: 1,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 100,
        turnIndex: 1,
        message: assistantText('a2', 'Completed slice'),
      }),
      makeRow({
        id: 'u1',
        label: 'Coder Agent',
        createdAt: t + 200,
        turnIndex: 1,
        message: humanUserMessage('u1', 'continue'),
        messageType: 'user',
      }),
      makeRow({
        id: 'retry1',
        label: 'Coder Agent',
        createdAt: t + 350,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'api_retry',
          uuid: 'retry1',
          session_id: 'space:s:task:t',
          attempt: 1,
          max_retries: 3,
          retry_delay_ms: 1000,
          error_status: 529,
          error: 'overloaded',
        },
      }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 400,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'completed',
          summary: 'completed slice folded once',
          output_file: '/tmp/o',
        },
      }),
    ];

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(
      entries.some((entry) => entry.textContent?.includes('completed slice folded once'))
    ).toBe(true);
    expect(screen.queryByText('Task completed')).toBeNull();
  });

  it('does not suppress active turn task_notification when active summary is missing', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        turnIndex: 1,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 100,
        turnIndex: 1,
        message: assistantText('a2', 'Still working'),
      }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 200,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'completed',
          summary: 'active summary missing',
          output_file: '/tmp/o',
        },
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);

    const turns = screen.getAllByTestId('minimal-thread-turn');
    expect(turns[0].dataset.turnState).toBe('active');
    const feed = screen.getByTestId('space-task-event-feed-minimal');
    expect(feed.textContent).toContain('Task completed');
    expect(feed.textContent).toContain('active summary missing');
  });

  it('keeps pre-result task_notifications inside completed slices for folding', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 100,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'completed',
          summary: 'settled before result',
          output_file: '/tmp/o',
        },
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 200,
        message: assistantText('a2', 'Done'),
      }),
      makeRow({ id: 'r1', label: 'Coder Agent', createdAt: t + 300, message: resultMessage('r1') }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    expect(screen.queryByText('Task completed')).toBeNull();
    const entry = screen.getByTestId('minimal-thread-roster-entry');
    expect(entry.dataset.taskStatus).toBe('completed');
    expect(entry.textContent).toContain('settled before result');
  });

  it('keeps capped pre-result task_notifications as standalone rows only', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse(
          'a1',
          Array.from({ length: 9 }, (_, i) => ({
            name: 'Bash',
            input: { command: `echo ${i + 1}` },
          }))
        ),
      }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 100,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'completed',
          summary: 'first tool done',
          output_file: '/tmp/o',
        },
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 200,
        message: assistantText('a2', 'Done'),
      }),
      makeRow({ id: 'r1', label: 'Coder Agent', createdAt: t + 300, message: resultMessage('r1') }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    const taskEntries = screen
      .getAllByTestId('minimal-thread-roster-entry')
      .filter((e) => (e as HTMLElement).dataset.rosterKind === 'task_notification');
    expect(taskEntries).toHaveLength(1);
    expect(taskEntries[0].textContent).toContain('Task completed');
    expect(taskEntries[0].textContent).toContain('first tool done');
  });

  it('folds completed slices inside active blocks without suppressing the active tail', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        turnIndex: 1,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 100,
        turnIndex: 1,
        message: assistantText('a2', 'Completed slice'),
      }),
      makeRow({
        id: 'u1',
        label: 'Coder Agent',
        createdAt: t + 200,
        turnIndex: 1,
        message: humanUserMessage('u1', 'continue'),
        messageType: 'user',
      }),
      makeRow({
        id: 'a3',
        label: 'Coder Agent',
        createdAt: t + 300,
        turnIndex: 1,
        message: assistantToolUse('a3', [{ name: 'Bash', input: { command: 'still running' } }]),
      }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 400,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'completed',
          summary: 'completed slice folded',
          output_file: '/tmp/o',
        },
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries.some((entry) => entry.textContent?.includes('completed slice folded'))).toBe(
      true
    );
    expect(screen.queryByText('Task completed')).toBeNull();
    const turns = screen.getAllByTestId('minimal-thread-turn');
    expect(turns.some((turn) => turn.dataset.turnState === 'active')).toBe(true);
  });

  it('does not suppress active turn task_notification after boundary-flushed slice', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        turnIndex: 1,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 100,
        turnIndex: 1,
        message: assistantText('a2', 'Still working'),
      }),
      makeRow({
        id: 'u1',
        label: 'Coder Agent',
        createdAt: t + 200,
        turnIndex: 1,
        message: humanUserMessage('u1', 'continue'),
        messageType: 'user',
      }),
      makeRow({
        id: 'a3',
        label: 'Coder Agent',
        createdAt: t + 300,
        turnIndex: 1,
        message: assistantToolUse('a3', [{ name: 'Bash', input: { command: 'still running' } }]),
      }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 400,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a3-0',
          status: 'completed',
          summary: 'boundary active fallback',
          output_file: '/tmp/o',
        },
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);

    const feed = screen.getByTestId('space-task-event-feed-minimal');
    expect(feed.textContent).toContain('Task completed');
    expect(feed.textContent).toContain('boundary active fallback');
  });

  it('renders the active rail and tool roster for the live turn when activeAgentLabels includes the agent', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [
          { name: 'Bash', input: { command: 'bun run typecheck' } },
          { name: 'Read', input: { file_path: 'packages/web/src/foo.ts' } },
        ]),
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: assistantToolUse('a2', [
          { name: 'Grep', input: { pattern: 'provisionExistingSpaces' } },
          { name: 'Bash', input: { command: 'git status' } },
        ]),
      }),
    ];

    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        { kind: 'tool_use', toolName: 'Bash', preview: 'bun run typecheck', ts: t, uuid: 'a1' },
        {
          kind: 'tool_use',
          toolName: 'Read',
          preview: 'packages/web/src/foo.ts',
          ts: t,
          uuid: 'a1',
        },
        {
          kind: 'tool_use',
          toolName: 'Grep',
          preview: 'provisionExistingSpaces',
          ts: t + 1000,
          uuid: 'a2',
        },
        { kind: 'tool_use', toolName: 'Bash', preview: 'git status', ts: t + 1000, uuid: 'a2' },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    const turn = screen.getByTestId('minimal-thread-turn');
    expect(turn.dataset.turnState).toBe('active');

    expect(screen.getByTestId('minimal-thread-active-rail')).toBeTruthy();

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries.length).toBe(4);
    const text = entries.map((e) => e.textContent).join('\n');
    expect(text).toContain('Bash');
    expect(text).toContain('bun run typecheck');
    expect(text).toContain('Read');
    expect(text).toContain('packages/web/src/foo.ts');
    expect(text).toContain('Grep');
    expect(text).toContain('provisionExistingSpaces');
    expect(text).toContain('git status');

    expect(turn.textContent).toContain('Running');
    const rail = screen.getByTestId('minimal-thread-active-rail');
    expect(rail.textContent).not.toContain('Running');
    expect(screen.getByTestId('minimal-thread-active-meta').textContent).toContain('⚙ 4');
    expect(turn.textContent).toContain('2 messages');
    expect(screen.getByTestId('minimal-thread-last-event').textContent).toContain('last event');
  });

  it('renders api_retry summary entries as dedicated roster rows', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        turnIndex: 1,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 'retry-1',
        label: 'Coder Agent',
        createdAt: t + 500,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'api_retry',
          uuid: 'retry-1',
          attempt: 2,
          max_retries: 3,
          retry_delay_ms: 5000,
          error_status: 429,
        },
      }),
    ];
    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        {
          kind: 'api_retry',
          attempt: 2,
          maxRetries: 3,
          retryDelayMs: 5000,
          errorStatus: 429,
          ts: t + 500,
          uuid: 'retry-1',
        },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].dataset.rosterKind).toBe('api_retry');
    expect(entries[0].textContent).toContain('API retry');
    expect(entries[0].textContent).toContain('attempt 2/3');
    expect(entries[0].textContent).toContain('status 429');
    expect(entries[0].textContent).toContain('delay 5000ms');
    expect(screen.getAllByText('API retry')).toHaveLength(1);
  });

  it('does not render api_retry in the main thread when capped out of the active roster (roster-only)', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        turnIndex: 1,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 'retry-1',
        label: 'Coder Agent',
        createdAt: t + 500,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'api_retry',
          uuid: 'retry-1',
          attempt: 1,
          max_retries: 3,
          retry_delay_ms: 1000,
          error_status: null,
        },
      }),
    ];
    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        {
          kind: 'api_retry',
          attempt: 1,
          maxRetries: 3,
          retryDelayMs: 1000,
          errorStatus: null,
          ts: t + 500,
          uuid: 'retry-1',
        },
        ...Array.from({ length: 8 }, (_, i) => ({
          kind: 'text' as const,
          text: `later ${i}`,
          ts: t + 600 + i,
          uuid: `later-${i}`,
        })),
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries.some((entry) => entry.dataset.rosterKind === 'api_retry')).toBe(false);
    const feed = screen.getByTestId('space-task-event-feed-minimal');
    expect(feed.textContent).not.toContain('API retry');
    expect(feed.textContent).not.toContain('Attempt 1/3');
  });

  it('folds task_notification onto the roster entry when the tool_use is rostered', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        turnIndex: 1,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 500,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'completed',
          summary: '42 tests passed',
          output_file: '/tmp/o',
        },
      }),
    ];
    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        {
          kind: 'tool_use',
          toolName: 'Bash',
          preview: 'bun test',
          ts: t,
          uuid: 'a1',
          toolUseId: 'tu-a1-0',
        },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    expect(screen.queryByText('Task completed')).toBeNull();
    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries[0].dataset.taskStatus).toBe('completed');
    expect(entries[0].textContent).toContain('42 tests passed');
  });

  it('does not fold when the summary turnIndex is stale vs the compact rows turn', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        turnIndex: 1,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 500,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'completed',
          summary: '42 tests passed',
          output_file: '/tmp/o',
        },
      }),
    ];
    const staleSummary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 2,
      entries: [
        {
          kind: 'tool_use',
          toolName: 'Bash',
          preview: 'bun test',
          ts: t,
          uuid: 'a1',
          toolUseId: 'tu-a1-0',
        },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[staleSummary]}
      />
    );

    const feed = screen.getByTestId('space-task-event-feed-minimal');
    expect(feed.textContent).toContain('42 tests passed');
    expect(feed.textContent).toContain('Task completed');
  });

  it('drops the active roster when the summary turnIndex mismatches the trailing turn', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        turnIndex: 1,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
    ];
    const staleSummary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 2,
      entries: [
        {
          kind: 'tool_use',
          toolName: 'Bash',
          preview: 'bun test',
          ts: t,
          uuid: 'a1',
          toolUseId: 'tu-a1-0',
        },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[staleSummary]}
      />
    );

    expect(screen.queryAllByTestId('minimal-thread-roster-entry')).toHaveLength(0);
  });

  it('labels a stopped task_notification as Task stopped, not Task failed', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
      }),
      makeRow({ id: 'r1', label: 'Coder Agent', createdAt: t + 100, message: resultMessage('r1') }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 200,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'stopped',
          summary: 'killed by user',
          output_file: '/tmp/o',
        },
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    const feed = screen.getByTestId('space-task-event-feed-minimal');
    expect(feed.textContent).toContain('Task stopped');
    expect(feed.textContent).not.toContain('Task failed');
  });

  it('folds task_notification onto a completed turn roster entry', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'false' } }]),
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 100,
        message: resultMessage('r1', 'Done'),
      }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 200,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'failed',
          summary: 'Bash exited 1',
          output_file: '/tmp/o',
          usage: { total_tokens: 4321, tool_uses: 3, duration_ms: 4500 },
        },
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    expect(screen.queryByText('Task failed')).toBeNull();
    const entry = screen.getByTestId('minimal-thread-roster-entry');
    expect(entry.dataset.rosterKind).toBe('tool');
    expect(entry.dataset.taskStatus).toBe('failed');
    expect(entry.textContent).toContain('Bash exited 1');
    expect(entry.textContent).toContain('4,321 tok');
    expect(entry.textContent).toContain('3 tools');
    expect(entry.textContent).toContain('4.5s');
    expect(entry.textContent).toContain('✗');
  });

  it('renders stopped task_notification distinctly when folded onto completed roster', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'sleep 10' } }]),
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 100,
        message: resultMessage('r1', 'Stopped'),
      }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 200,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'stopped',
          summary: 'cancelled by user',
          output_file: '/tmp/o',
        },
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    expect(screen.queryByTestId('minimal-thread-system')).toBeNull();
    const entry = screen.getByTestId('minimal-thread-roster-entry');
    expect(entry.dataset.taskStatus).toBe('stopped');
    expect(entry.textContent).toContain('Task stopped');
    expect(entry.textContent).toContain('cancelled by user');
    expect(entry.textContent).toContain('■');
    expect(entry.textContent).not.toContain('✗');
    expect(entry.querySelector('[aria-label="task stopped"]')).toBeTruthy();
    expect(entry.querySelector('[aria-label="task failed"]')).toBeNull();
  });

  it('caps completed roster previews and suppresses MCP previews', () => {
    const t = Date.now();
    const longCommand = `node -e "${'x'.repeat(240)}"`;
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [
          { name: 'Bash', input: { command: longCommand } },
          { name: 'mcp__node-agent__send_message', input: { message: 'secret '.repeat(80) } },
        ]),
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 100,
        message: resultMessage('r1', 'Done'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    const bashText = entries[0].textContent ?? '';
    expect(bashText).toContain('…');
    expect(bashText).not.toContain(longCommand);
    expect(bashText.length).toBeLessThan(longCommand.length);
    expect(entries[1].textContent).not.toContain('secret');
  });

  it('renders a standalone roster entry for task_notification with no roster target (completed turn)', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse(
          'a1',
          Array.from({ length: 9 }, (_, i) => ({
            name: 'Bash',
            input: { command: `echo ${i + 1}` },
          }))
        ),
      }),
      makeRow({ id: 'r1', label: 'Coder Agent', createdAt: t + 100, message: resultMessage('r1') }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 200,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'failed',
          summary: 'Bash exited 1',
          output_file: '/tmp/o',
          usage: { total_tokens: 4321, tool_uses: 3, duration_ms: 4500 },
        },
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    const taskEntries = screen
      .getAllByTestId('minimal-thread-roster-entry')
      .filter((e) => (e as HTMLElement).dataset.rosterKind === 'task_notification');
    expect(taskEntries).toHaveLength(1);
    expect(taskEntries[0].textContent).toContain('Task failed');
    expect(taskEntries[0].textContent).toContain('Bash exited 1');
    expect(taskEntries[0].textContent).toContain('4,321 tok');
    expect(taskEntries[0].textContent).toContain('3 tools');
  });

  it('preserves both folded and standalone outcomes in a completed turn (no merged-cap eviction)', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Task', input: { request: 'capped subtask' } }]),
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 10,
        message: assistantToolUse('a2', [{ name: 'Task', input: { request: 'retained subtask' } }]),
      }),
      makeRow({
        id: 'a3',
        label: 'Coder Agent',
        createdAt: t + 20,
        message: assistantToolUse(
          'a3',
          Array.from({ length: 7 }, (_, i) => ({
            name: 'Bash',
            input: { command: `fill ${i + 1}` },
          }))
        ),
      }),
      makeRow({
        id: 'n2',
        label: 'Coder Agent',
        createdAt: t + 30,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'tk',
          tool_use_id: 'tu-a2-0',
          status: 'completed',
          summary: 'retained subtask done',
          output_file: '/tmp/o',
        },
      }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 90,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'tk',
          tool_use_id: 'tu-a1-0',
          status: 'completed',
          summary: 'capped subtask done',
          output_file: '/tmp/o',
        },
      }),
      makeRow({ id: 'r1', label: 'Coder Agent', createdAt: t + 100, message: resultMessage('r1') }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    const standalone = entries.filter(
      (e) => (e as HTMLElement).dataset.rosterKind === 'task_notification'
    );
    expect(standalone).toHaveLength(1);
    expect(standalone[0].textContent).toContain('capped subtask done');
    expect(
      entries.some(
        (e) =>
          (e as HTMLElement).dataset.rosterKind === 'tool' &&
          e.textContent?.includes('retained subtask done')
      )
    ).toBe(true);
  });

  it('does not duplicate a task_notification that folds onto a rostered tool (roster-only turn)', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({ id: 'r1', label: 'Coder Agent', createdAt: t + 100, message: resultMessage('r1') }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 200,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'completed',
          summary: 'all tests passed',
          output_file: '/tmp/o',
          usage: { total_tokens: 500, tool_uses: 1, duration_ms: 1200 },
        },
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    const standalone = screen
      .getAllByTestId('minimal-thread-roster-entry')
      .filter((e) => (e as HTMLElement).dataset.rosterKind === 'task_notification');
    expect(standalone).toHaveLength(0);
    const toolEntries = screen
      .getAllByTestId('minimal-thread-roster-entry')
      .filter((e) => (e as HTMLElement).dataset.rosterKind === 'tool');
    expect(toolEntries.some((e) => e.textContent?.includes('all tests passed'))).toBe(true);
  });

  it('falls back to a row when a stale summary lingers after the turn went terminal', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({ id: 'r1', label: 'Coder Agent', createdAt: t + 100, message: resultMessage('r1') }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 200,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-0',
          status: 'completed',
          summary: 'all green',
          output_file: '/tmp/o',
        },
      }),
    ];
    const staleSummary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        {
          kind: 'tool_use',
          toolName: 'Bash',
          preview: 'bun test',
          ts: t,
          uuid: 'a1',
          toolUseId: 'tu-a1-0',
        },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[staleSummary]}
      />
    );

    const feed = screen.getByTestId('space-task-event-feed-minimal');
    expect(feed.textContent).toContain('all green');
  });

  it('does not suppress a capped task_notification when a rostered api_retry splits the active pre-scan', () => {
    const t = Date.now();
    const summaryEntries: ActiveTurnSummary['entries'] = [
      ...Array.from({ length: 9 }, (_, i) => ({
        kind: 'tool_use' as const,
        toolName: 'Bash',
        preview: `echo ${i + 1}`,
        ts: t + i,
        uuid: 'a1',
        toolUseId: `tu-a1-${i}`,
      })),
      {
        kind: 'api_retry' as const,
        attempt: 1,
        maxRetries: 3,
        retryDelayMs: 1000,
        errorStatus: 529,
        ts: t + 100,
        uuid: 'retry1',
      },
    ];
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        turnIndex: 1,
        message: assistantToolUse(
          'a1',
          Array.from({ length: 9 }, (_, i) => ({
            name: 'Bash',
            input: { command: `echo ${i + 1}` },
          }))
        ),
      }),
      makeRow({
        id: 'a1-text',
        label: 'Coder Agent',
        createdAt: t + 50,
        turnIndex: 1,
        message: assistantText('a1-text', 'working on it'),
      }),
      makeRow({
        id: 'retry1',
        label: 'Coder Agent',
        createdAt: t + 100,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'api_retry',
          uuid: 'retry1',
          session_id: 'space:s:task:t',
          attempt: 1,
          max_retries: 3,
          retry_delay_ms: 1000,
          error_status: 529,
          error: 'overloaded',
        },
      }),
      makeRow({
        id: 'post-retry-text',
        label: 'Coder Agent',
        createdAt: t + 150,
        turnIndex: 1,
        message: assistantText('post-retry-text', 'still working after retry'),
      }),
      makeRow({
        id: 'n1',
        label: 'Coder Agent',
        createdAt: t + 200,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't',
          tool_use_id: 'tu-a1-1',
          status: 'failed',
          summary: 'second tool failed after retry',
          output_file: '/tmp/o',
          usage: { total_tokens: 1234, tool_uses: 1, duration_ms: 2500 },
        },
      }),
    ];
    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: summaryEntries,
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    const feed = screen.getByTestId('space-task-event-feed-minimal');
    expect(feed.textContent).toContain('Task failed');
    expect(feed.textContent).toContain('second tool failed after retry');
    expect(feed.textContent).toContain('1,234 tok');
  });

  it('caps the active roster at 8 most-recent tool calls', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'placeholder' } }]),
      }),
    ];

    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 1', ts: t + 1, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 2', ts: t + 2, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 3', ts: t + 3, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 4', ts: t + 4, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 5', ts: t + 5, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 6', ts: t + 6, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 7', ts: t + 7, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 8', ts: t + 8, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 9', ts: t + 9, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 10', ts: t + 10, uuid: 'a1' },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );
    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries.length).toBe(8);
    expect(entries[0].textContent).toContain('echo 3');
    expect(entries[7].textContent).toContain('echo 10');
    expect(entries[0].textContent).not.toContain('echo 1');
    expect(entries[0].textContent).not.toContain('echo 2');
  });

  it('ages out a stale standalone task_notification once >8 newer tool calls arrive (active turn)', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a0',
        label: 'Coder Agent',
        createdAt: t,
        turnIndex: 1,
        message: assistantToolUse('a0', [{ name: 'Task', input: { request: 'old subtask' } }]),
      }),
      makeRow({
        id: 'n0',
        label: 'Coder Agent',
        createdAt: t + 1,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'tk',
          tool_use_id: 'tu-a0-0',
          status: 'completed',
          summary: 'stale old completion',
          output_file: '/tmp/o',
        },
      }),
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t + 900,
        turnIndex: 1,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'echo 9' } }]),
      }),
    ];

    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        { kind: 'tool_use', toolName: 'Bash', preview: 'newer 1', ts: t + 100, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'newer 2', ts: t + 200, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'newer 3', ts: t + 300, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'newer 4', ts: t + 400, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'newer 5', ts: t + 500, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'newer 6', ts: t + 600, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'newer 7', ts: t + 700, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'newer 8', ts: t + 800, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'newer 9', ts: t + 900, uuid: 'a1' },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    const taskEntries = entries.filter(
      (e) => (e as HTMLElement).dataset.rosterKind === 'task_notification'
    );
    expect(taskEntries).toHaveLength(0);
    expect(screen.queryByText('Task completed')).toBeNull();
    expect(entries.some((e) => e.textContent?.includes('stale old completion'))).toBe(false);
    const toolEntries = entries.filter((e) => (e as HTMLElement).dataset.rosterKind === 'tool');
    expect(toolEntries).toHaveLength(8);
    expect(toolEntries[0].textContent).toContain('newer 2');
    expect(toolEntries[7].textContent).toContain('newer 9');
  });

  it('interleaves a standalone task_notification at its timestamp (mid-roster, not pinned)', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a0',
        label: 'Coder Agent',
        createdAt: t,
        turnIndex: 1,
        message: assistantToolUse('a0', [{ name: 'Task', input: { request: 'old subtask' } }]),
      }),
      makeRow({
        id: 'n0',
        label: 'Coder Agent',
        createdAt: t + 450,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'tk',
          tool_use_id: 'tu-a0-0',
          status: 'completed',
          summary: 'mid notification',
          output_file: '/tmp/o',
        },
      }),
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t + 800,
        turnIndex: 1,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'echo 8' } }]),
      }),
    ];
    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        { kind: 'tool_use', toolName: 'Bash', preview: 'tool 1', ts: t + 100, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'tool 2', ts: t + 200, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'tool 3', ts: t + 300, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'tool 4', ts: t + 400, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'tool 5', ts: t + 500, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'tool 6', ts: t + 600, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'tool 7', ts: t + 700, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'tool 8', ts: t + 800, uuid: 'a1' },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries).toHaveLength(8);
    expect(entries[7].textContent).toContain('tool 8');
    expect(entries[7].dataset.rosterKind).toBe('tool');
    const notifIdx = entries.findIndex(
      (e) => (e as HTMLElement).dataset.rosterKind === 'task_notification'
    );
    expect(notifIdx).toBeGreaterThan(-1);
    expect(notifIdx).toBeLessThan(7);
    expect(entries[notifIdx].textContent).toContain('mid notification');
    expect(entries[notifIdx - 1].textContent).toContain('tool 4');
    expect(entries[notifIdx + 1].textContent).toContain('tool 5');
  });

  it('ages out a standalone task_notification that ties the window on the same millisecond', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a0',
        label: 'Coder Agent',
        createdAt: t,
        turnIndex: 1,
        message: assistantToolUse('a0', [{ name: 'Task', input: { request: 'old subtask' } }]),
      }),
      makeRow({
        id: 'n0',
        label: 'Coder Agent',
        createdAt: t + 100,
        turnIndex: 1,
        messageType: 'system',
        message: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'tk',
          tool_use_id: 'tu-a0-0',
          status: 'completed',
          summary: 'same ms completion',
          output_file: '/tmp/o',
        },
      }),
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t + 100,
        turnIndex: 1,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'echo 8' } }]),
      }),
    ];
    const sameMs = t + 100;
    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: Array.from({ length: 8 }, (_, i) => ({
        kind: 'tool_use' as const,
        toolName: 'Bash',
        preview: `tie tool ${i + 1}`,
        ts: sameMs,
        uuid: 'a1',
      })),
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(
      entries.filter((e) => (e as HTMLElement).dataset.rosterKind === 'task_notification')
    ).toHaveLength(0);
    expect(screen.queryByText('Task completed')).toBeNull();
    expect(entries.filter((e) => (e as HTMLElement).dataset.rosterKind === 'tool')).toHaveLength(8);
  });

  it('does not show the active rail on completed blocks', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantText('a1', 'done'),
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: resultMessage('r1'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);
    expect(screen.queryByTestId('minimal-thread-active-rail')).toBeNull();
    expect(screen.getByTestId('minimal-thread-turn').dataset.turnState).toBe('completed');
  });

  it('treats the last block as completed when activeAgentLabels is empty', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: assistantText('a2', 'inspecting'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set()} />);
    const turn = screen.getByTestId('minimal-thread-turn');
    expect(turn.dataset.turnState).toBe('completed');
    expect(screen.queryByTestId('minimal-thread-active-rail')).toBeNull();
  });

  it('renders a human user message as a message turn with User → recipient header', async () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'u1',
        label: 'Coder Agent',
        createdAt: t,
        message: humanUserMessage('u1', 'help me add dark mode'),
      }),
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: assistantText('a1', 'on it'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);
    const turns = screen.getAllByTestId('minimal-thread-turn');
    expect(turns.length).toBe(2);

    const messageTurn = turns[0];
    expect(messageTurn.dataset.turnState).toBe('message');
    expect(messageTurn.dataset.fromLabel).toBe('User');
    expect(messageTurn.dataset.toLabel).toBe('Coder Agent');
    expect(messageTurn.dataset.messageKind).toBe('human');
    await waitFor(() => {
      expect(screen.getByText('help me add dark mode')).toBeTruthy();
    });

    expect(turns[1].dataset.turnState).toBe('completed');
    expect(turns[1].dataset.agentLabel).toBe('Coder Agent');
  });

  it('renders a synthetic peer-origin message as Sender → recipient with handoff badge', async () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'u1',
        label: 'Coder Agent',
        createdAt: t,
        message: syntheticPeerMessage('u1', 'please address the failing test', {
          name: 'Reviewer Agent',
          sessionId: 'session-rev',
        }),
      }),
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: assistantText('a1', 'fixed'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);
    const messageTurn = screen.getAllByTestId('minimal-thread-turn')[0];
    expect(messageTurn.dataset.turnState).toBe('message');
    expect(messageTurn.dataset.fromLabel).toBe('Reviewer Agent');
    expect(messageTurn.dataset.toLabel).toBe('Coder Agent');
    expect(messageTurn.textContent).toContain('REVIEWER');
    expect(messageTurn.textContent).toContain('CODER');
    expect(messageTurn.textContent?.toLowerCase()).toContain('synthetic');
    expect(
      messageTurn.querySelector('[data-testid="synthetic-message"] > div')?.className
    ).toContain('md:max-w-[86%]');
    await waitFor(() => {
      expect(screen.getByText('please address the failing test')).toBeTruthy();
    });
  });

  it('uses row origin to classify runtime user messages when content has no origin', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'u1',
        label: 'Task Agent',
        createdAt: t,
        message: humanUserMessage('u1', 'runtime handoff'),
        origin: 'system',
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);
    const messageTurn = screen.getByTestId('minimal-thread-turn');
    expect(messageTurn.dataset.turnState).toBe('message');
    expect(messageTurn.dataset.fromLabel).toBe('System');
    expect(messageTurn.dataset.toLabel).toBe('Task Agent');
    expect(messageTurn.dataset.messageKind).toBe('synthetic');
    expect(messageTurn.textContent?.toLowerCase()).toContain('synthetic');
  });

  it('infers sender from previous block when a replay message has no origin', async () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a-rev',
        label: 'Reviewer Agent',
        createdAt: t,
        message: assistantText('a-rev', 'looks good but please fix x'),
      }),
      makeRow({
        id: 'r-rev',
        label: 'Reviewer Agent',
        createdAt: t + 100,
        message: resultMessage('r-rev'),
      }),
      makeRow({
        id: 'u1',
        label: 'Coder Agent',
        createdAt: t + 200,
        message: replayUserMessage('u1', 'address the review feedback'),
      }),
      makeRow({
        id: 'a-coder',
        label: 'Coder Agent',
        createdAt: t + 300,
        message: assistantText('a-coder', 'on it'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);
    const turns = screen.getAllByTestId('minimal-thread-turn');
    expect(turns.length).toBe(3);
    expect(turns[1].dataset.turnState).toBe('message');
    expect(turns[1].dataset.fromLabel).toBe('Reviewer Agent');
    expect(turns[1].dataset.toLabel).toBe('Coder Agent');
    await waitFor(() => {
      expect(screen.getByText('address the review feedback')).toBeTruthy();
    });
  });

  it('orders the message turn before the recipient agent turn within a block', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'u1',
        label: 'Coder Agent',
        createdAt: t,
        message: humanUserMessage('u1', 'hello'),
      }),
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: assistantText('a1', 'hi back'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);
    const turns = screen.getAllByTestId('minimal-thread-turn');
    expect(turns[0].dataset.turnState).toBe('message');
    expect(turns[1].dataset.turnState).toBe('completed');
  });

  it('still treats the trailing block as active when a user message precedes the assistant rows', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'u1',
        label: 'Coder Agent',
        createdAt: t,
        message: humanUserMessage('u1', 'go'),
      }),
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);
    const turns = screen.getAllByTestId('minimal-thread-turn');
    expect(turns[0].dataset.turnState).toBe('message');
    expect(turns[1].dataset.turnState).toBe('active');
    expect(screen.getByTestId('minimal-thread-active-rail')).toBeTruthy();
  });

  it('shows the completed stats line under the agent name (not inside the bubble)', async () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 30_000,
        message: assistantText('a2', 'all done'),
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 31_000,
        message: resultMessage('r1'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);
    const turn = screen.getByTestId('minimal-thread-turn');
    expect(turn.textContent).toContain('1 tool call');
    expect(turn.textContent).toContain('3 messages');

    const meta = screen.getByTestId('minimal-thread-agent-meta');
    expect(meta).toBeTruthy();
    expect(meta.textContent).toContain('1 tool call');
    expect(meta.textContent).toContain('3 messages');

    const bubble = screen.getByTestId('minimal-thread-agent-bubble');
    expect(bubble.contains(meta)).toBe(false);
    expect(bubble.textContent).not.toContain('1 tool call');
  });

  it('includes assistant text messages in the active roster alongside tool calls', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
      }),
    ];

    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        { kind: 'text', text: 'Investigating the failing test', ts: t, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'ls', ts: t, uuid: 'a1' },
        { kind: 'text', text: 'Now editing the broken assertion', ts: t + 1000, uuid: 'a2' },
        { kind: 'tool_use', toolName: 'Edit', preview: 'foo.ts', ts: t + 1000, uuid: 'a2' },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries.length).toBe(4);
    expect(entries[0].dataset.rosterKind).toBe('message');
    expect(entries[0].textContent).toContain('Investigating the failing test');
    expect(entries[1].dataset.rosterKind).toBe('tool');
    expect(entries[1].textContent).toContain('Bash');
    expect(entries[2].dataset.rosterKind).toBe('message');
    expect(entries[2].textContent).toContain('Now editing the broken assertion');
    expect(entries[3].dataset.rosterKind).toBe('tool');
    expect(entries[3].textContent).toContain('Edit');
    const meta = screen.getByTestId('minimal-thread-active-meta');
    expect(meta.textContent).toContain('✦ 0');
    expect(meta.textContent).toContain('💬 2');
    expect(meta.textContent).toContain('⚙ 2');
  });

  it('skips empty/whitespace assistant text entries when building the roster', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
      }),
    ];

    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        { kind: 'text', text: '   ', ts: t, uuid: 'a1' },
        { kind: 'text', text: '', ts: t, uuid: 'a1' },
        { kind: 'thinking', preview: '', ts: t, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'ls', ts: t, uuid: 'a1' },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );
    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries.length).toBe(1);
    expect(entries[0].dataset.rosterKind).toBe('tool');
  });

  describe('Action row dropdowns (system:init / result)', () => {
    it('renders the result dropdown trigger under a completed agent turn', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantText('a1', 'all done'),
        }),
        makeRow({
          id: 'r1',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: resultMessage('r1'),
        }),
      ];

      const { container } = render(<MinimalThreadFeed parsedRows={rows} />);
      const trigger = container.querySelector('button[title="Run result"]');
      expect(trigger).not.toBeNull();
    });

    it('only renders result trigger on the segment that contains the result row', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantText('a1', 'before compact'),
        }),
        makeRow({
          id: 'c1',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: compactBoundaryMessage('c1', {
            trigger: 'manual',
            pre_tokens: 90000,
            post_tokens: 15000,
          }),
        }),
        makeRow({
          id: 'a2',
          label: 'Coder Agent',
          createdAt: t + 2000,
          message: assistantText('a2', 'after compact'),
        }),
        makeRow({
          id: 'r1',
          label: 'Coder Agent',
          createdAt: t + 3000,
          message: resultMessage('r1'),
        }),
      ];

      const { container } = render(<MinimalThreadFeed parsedRows={rows} />);
      const turns = screen.getAllByTestId('minimal-thread-turn');
      const completedTurns = turns.filter((turn) => turn.dataset.turnState === 'completed');
      expect(completedTurns.length).toBe(2);
      expect(completedTurns[0].querySelector('button[title="Run result"]')).toBeNull();
      expect(completedTurns[1].querySelector('button[title="Run result"]')).not.toBeNull();
      expect(container.querySelectorAll('button[title="Run result"]').length).toBe(1);
    });

    it('does not render the result trigger when the block has no result envelope', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantText('a1', 'still working'),
        }),
      ];

      const { container } = render(<MinimalThreadFeed parsedRows={rows} />);
      expect(container.querySelector('button[title="Run result"]')).toBeNull();
    });

    it('renders the session-info dropdown trigger under a human user message when block has system:init', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 's1',
          label: 'Coder Agent',
          createdAt: t,
          message: systemInitMessage('s1'),
        }),
        makeRow({
          id: 'u1',
          label: 'Coder Agent',
          createdAt: t + 100,
          message: humanUserMessage('u1', 'help me add dark mode'),
        }),
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: assistantText('a1', 'on it'),
        }),
      ];

      const { container } = render(<MinimalThreadFeed parsedRows={rows} />);
      const triggers = container.querySelectorAll('button[title="Session info"]');
      expect(triggers.length).toBeGreaterThanOrEqual(1);
    });

    it('renders the session-info dropdown trigger under a synthetic peer-origin message when block has system:init', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 's1',
          label: 'Coder Agent',
          createdAt: t,
          message: systemInitMessage('s1'),
        }),
        makeRow({
          id: 'u1',
          label: 'Coder Agent',
          createdAt: t + 100,
          message: syntheticPeerMessage('u1', 'please look at the failing test', {
            name: 'Reviewer Agent',
            sessionId: 'session-rev',
          }),
        }),
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: assistantText('a1', 'looking'),
        }),
      ];

      const { container } = render(<MinimalThreadFeed parsedRows={rows} />);
      const triggers = container.querySelectorAll('button[title="Session info"]');
      expect(triggers.length).toBeGreaterThanOrEqual(1);
    });

    it('does not render the session-info trigger when the block has no system:init envelope', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'u1',
          label: 'Coder Agent',
          createdAt: t,
          message: humanUserMessage('u1', 'no init in this block'),
        }),
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: assistantText('a1', 'ok'),
        }),
      ];

      const { container } = render(<MinimalThreadFeed parsedRows={rows} />);
      expect(container.querySelector('button[title="Session info"]')).toBeNull();
    });

    it('paints the result trigger amber for error subtypes', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantText('a1', 'attempting'),
        }),
        makeRow({
          id: 'r1',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: errorResultMessage('r1'),
        }),
      ];

      const { container } = render(<MinimalThreadFeed parsedRows={rows} />);
      const trigger = container.querySelector('button[title="Run result"]');
      expect(trigger).not.toBeNull();
      expect(trigger?.className).toMatch(/amber/);
    });
  });

  describe('Terminal result error inline surfacing', () => {
    it('paints the completed turn bubble red and surfaces the error inline for error subtypes', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantText('a1', 'attempting'),
        }),
        makeRow({
          id: 'r1',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: errorResultMessage('r1'),
        }),
      ];

      const { container } = render(<MinimalThreadFeed parsedRows={rows} />);
      const bubble = container.querySelector('[data-testid="minimal-thread-agent-bubble"]');
      expect(bubble).not.toBeNull();
      expect(bubble?.getAttribute('data-result-error')).toBe('true');
      expect(bubble?.className).toMatch(/bg-red-900\/20/);
      expect(bubble?.className).toMatch(/border-red-800/);
      const summary = container.querySelector(
        '[data-testid="minimal-thread-result-error-summary"]'
      );
      expect(summary).not.toBeNull();
      expect(summary?.textContent).toContain('something failed');
    });

    it('excludes error_max_budget_usd from the inline red treatment', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantText('a1', 'ran out of budget'),
        }),
        makeRow({
          id: 'r1',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: budgetErrorResultMessage('r1'),
        }),
      ];

      const { container } = render(<MinimalThreadFeed parsedRows={rows} />);
      const bubble = container.querySelector('[data-testid="minimal-thread-agent-bubble"]');
      expect(bubble).not.toBeNull();
      expect(bubble?.getAttribute('data-result-error')).toBeNull();
      expect(bubble?.className).not.toMatch(/bg-red-900/);
      expect(
        container.querySelector('[data-testid="minimal-thread-result-error-summary"]')
      ).toBeNull();
      expect(container.querySelector('button[title="Run result"]')).not.toBeNull();
    });

    it('does not paint the bubble red for successful results', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantText('a1', 'all good'),
        }),
        makeRow({
          id: 'r1',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: resultMessage('r1', 'done'),
        }),
      ];

      const { container } = render(<MinimalThreadFeed parsedRows={rows} />);
      const bubble = container.querySelector('[data-testid="minimal-thread-agent-bubble"]');
      expect(bubble).not.toBeNull();
      expect(bubble?.getAttribute('data-result-error')).toBeNull();
      expect(bubble?.className).toMatch(/bg-dark-800/);
      expect(
        container.querySelector('[data-testid="minimal-thread-result-error-summary"]')
      ).toBeNull();
    });

    it('falls back to a subtype label when errors[] is empty', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantText('a1', 'attempting'),
        }),
        makeRow({
          id: 'r1',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: errorResultMessageWithEmptyErrors('r1'),
        }),
      ];

      const { container } = render(<MinimalThreadFeed parsedRows={rows} />);
      const bubble = container.querySelector('[data-testid="minimal-thread-agent-bubble"]');
      expect(bubble?.getAttribute('data-result-error')).toBe('true');
      const summary = container.querySelector(
        '[data-testid="minimal-thread-result-error-summary"]'
      );
      expect(summary).not.toBeNull();
      expect(summary?.textContent).toContain('Error during execution');
    });

    it('keeps a terminal-error turn visible even when the agent emitted no reply text', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'echo test' } }]),
        }),
        makeRow({
          id: 'r1',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: errorResultMessage('r1'),
        }),
      ];

      const { container } = render(<MinimalThreadFeed parsedRows={rows} />);
      const bubble = container.querySelector('[data-testid="minimal-thread-agent-bubble"]');
      expect(bubble).not.toBeNull();
      expect(bubble?.getAttribute('data-result-error')).toBe('true');
      const summary = container.querySelector(
        '[data-testid="minimal-thread-result-error-summary"]'
      );
      expect(summary?.textContent).toContain('something failed');
    });

    it('keeps a budget-cap turn visible even when the agent emitted no reply text', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'echo test' } }]),
        }),
        makeRow({
          id: 'r1',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: budgetErrorResultMessage('r1'),
        }),
      ];

      const { container } = render(<MinimalThreadFeed parsedRows={rows} />);
      const bubble = container.querySelector('[data-testid="minimal-thread-agent-bubble"]');
      expect(bubble).not.toBeNull();
      expect(bubble?.getAttribute('data-result-error')).toBeNull();
      expect(bubble?.className).not.toMatch(/bg-red-900/);
      expect(container.querySelector('button[title="Run result"]')).not.toBeNull();
    });

    it('folds post-result task_notification onto an error-only turn instead of duplicating', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
        }),
        makeRow({
          id: 'r1',
          label: 'Coder Agent',
          createdAt: t + 100,
          message: errorResultMessage('r1'),
        }),
        makeRow({
          id: 'n1',
          label: 'Coder Agent',
          createdAt: t + 200,
          messageType: 'system',
          message: {
            type: 'system',
            subtype: 'task_notification',
            task_id: 'task-x',
            tool_use_id: 'tu-a1-0',
            status: 'failed',
            summary: 'tests failed',
            output_file: '/tmp/o',
          },
        }),
      ];

      render(<MinimalThreadFeed parsedRows={rows} />);

      const bubble = screen.getByTestId('minimal-thread-agent-bubble');
      expect(bubble.getAttribute('data-result-error')).toBe('true');
      const entry = screen.getByTestId('minimal-thread-roster-entry');
      expect(entry.dataset.taskStatus).toBe('failed');
      expect(entry.textContent).toContain('tests failed');
      expect(screen.queryByText('Task failed')).toBeNull();
    });

    it('keeps tool_use visible across operational system row splits in error-only turns', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
        }),
        makeRow({
          id: 's1',
          label: 'Coder Agent',
          createdAt: t + 50,
          messageType: 'system',
          message: operationalSystemMessage('s1', 'model_refusal_fallback', {
            content: 'Retried with fallback model',
            original_model: 'claude-opus-4-5',
            fallback_model: 'claude-sonnet-4-5',
          }),
        }),
        makeRow({
          id: 'r1',
          label: 'Coder Agent',
          createdAt: t + 100,
          message: errorResultMessage('r1'),
        }),
        makeRow({
          id: 'n1',
          label: 'Coder Agent',
          createdAt: t + 200,
          messageType: 'system',
          message: {
            type: 'system',
            subtype: 'task_notification',
            task_id: 'task-x',
            tool_use_id: 'tu-a1-0',
            status: 'failed',
            summary: 'tests failed',
          },
        }),
      ];

      render(<MinimalThreadFeed parsedRows={rows} />);

      const bubbles = screen.getAllByTestId('minimal-thread-agent-bubble');
      expect(bubbles).toHaveLength(2);
      const toolEntry = screen.getByTestId('minimal-thread-roster-entry');
      expect(toolEntry.dataset.taskStatus).toBe('failed');
      expect(toolEntry.textContent).toContain('tests failed');
      const errorBubble = bubbles.find((b) => b.getAttribute('data-result-error') === 'true');
      expect(errorBubble).toBeDefined();
      const summary = screen.getByTestId('minimal-thread-result-error-summary');
      expect(summary.textContent).toContain('something failed');
      expect(screen.queryByText('Task failed')).toBeNull();
    });
  });

  it('caps the active roster at 8 most-recent entries even with mixed kinds', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'echo 3' } }]),
      }),
    ];

    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        { kind: 'text', text: 'msg-1', ts: t + 1, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 1', ts: t + 2, uuid: 'a1' },
        { kind: 'text', text: 'msg-2', ts: t + 3, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 2', ts: t + 4, uuid: 'a1' },
        { kind: 'text', text: 'msg-3', ts: t + 5, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 3', ts: t + 6, uuid: 'a1' },
        { kind: 'text', text: 'msg-4', ts: t + 7, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 4', ts: t + 8, uuid: 'a1' },
        { kind: 'text', text: 'msg-5', ts: t + 9, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'echo 5', ts: t + 10, uuid: 'a1' },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );
    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries.length).toBe(8);
    const allText = entries.map((e) => e.textContent).join('\n');
    expect(allText).not.toContain('msg-1');
    expect(allText).not.toContain('echo 1');
    expect(allText).toContain('msg-2');
    expect(allText).toContain('echo 2');
    expect(allText).toContain('msg-5');
    expect(allText).toContain('echo 5');
  });

  describe('Per-agent active rail (multi-session)', () => {
    it('keeps the Coder rail active when Reviewer just emitted a terminal result after Coder', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a-coder-1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantToolUse('a-coder-1', [
            { name: 'Bash', input: { command: 'bun run typecheck' } },
          ]),
        }),
        makeRow({
          id: 'a-coder-2',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: assistantText('a-coder-2', 'investigating'),
        }),
        makeRow({
          id: 'a-rev',
          label: 'Reviewer Agent',
          createdAt: t + 2000,
          message: assistantText('a-rev', 'looks good so far'),
        }),
        makeRow({
          id: 'r-rev',
          label: 'Reviewer Agent',
          createdAt: t + 2500,
          message: resultMessage('r-rev'),
        }),
      ];

      render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);

      const turns = screen.getAllByTestId('minimal-thread-turn');
      const coderTurn = turns.find((t) => t.dataset.agentLabel === 'Coder Agent');
      const reviewerTurn = turns.find((t) => t.dataset.agentLabel === 'Reviewer Agent');
      expect(coderTurn?.dataset.turnState).toBe('active');
      expect(reviewerTurn?.dataset.turnState).toBe('completed');
      expect(screen.getAllByTestId('minimal-thread-active-rail').length).toBe(1);
    });

    it('mirrors: keeps the Reviewer rail active when Coder just finished before Reviewer', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a-coder',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantText('a-coder', 'patch sent'),
        }),
        makeRow({
          id: 'r-coder',
          label: 'Coder Agent',
          createdAt: t + 500,
          message: resultMessage('r-coder'),
        }),
        makeRow({
          id: 'a-rev-1',
          label: 'Reviewer Agent',
          createdAt: t + 1000,
          message: assistantToolUse('a-rev-1', [{ name: 'Bash', input: { command: 'bun test' } }]),
        }),
        makeRow({
          id: 'a-rev-2',
          label: 'Reviewer Agent',
          createdAt: t + 1500,
          message: assistantText('a-rev-2', 'verifying tests'),
        }),
      ];

      render(
        <MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Reviewer Agent'])} />
      );

      const turns = screen.getAllByTestId('minimal-thread-turn');
      const coderTurn = turns.find((t) => t.dataset.agentLabel === 'Coder Agent');
      const reviewerTurn = turns.find((t) => t.dataset.agentLabel === 'Reviewer Agent');
      expect(coderTurn?.dataset.turnState).toBe('completed');
      expect(reviewerTurn?.dataset.turnState).toBe('active');
      expect(screen.getAllByTestId('minimal-thread-active-rail').length).toBe(1);
    });

    it('renders one rail per agent when both agents are running concurrently', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a-coder-1',
          label: 'Coder Agent',
          createdAt: t,
          message: assistantToolUse('a-coder-1', [
            { name: 'Bash', input: { command: 'bun build' } },
          ]),
        }),
        makeRow({
          id: 'a-coder-2',
          label: 'Coder Agent',
          createdAt: t + 1000,
          message: assistantText('a-coder-2', 'still going'),
        }),
        makeRow({
          id: 'a-rev-1',
          label: 'Reviewer Agent',
          createdAt: t + 2000,
          message: assistantToolUse('a-rev-1', [{ name: 'Read', input: { file_path: 'foo.ts' } }]),
        }),
        makeRow({
          id: 'a-rev-2',
          label: 'Reviewer Agent',
          createdAt: t + 3000,
          message: assistantText('a-rev-2', 'checking'),
        }),
      ];

      render(
        <MinimalThreadFeed
          parsedRows={rows}
          activeAgentLabels={new Set(['Coder Agent', 'Reviewer Agent'])}
        />
      );

      const turns = screen.getAllByTestId('minimal-thread-turn');
      const coderTurn = turns.find((t) => t.dataset.agentLabel === 'Coder Agent');
      const reviewerTurn = turns.find((t) => t.dataset.agentLabel === 'Reviewer Agent');
      expect(coderTurn?.dataset.turnState).toBe('active');
      expect(reviewerTurn?.dataset.turnState).toBe('active');
      expect(screen.getAllByTestId('minimal-thread-active-rail').length).toBe(2);
    });

    it('matches active-agent labels case- and whitespace-insensitively', () => {
      const t = Date.now();
      const rows = [
        makeRow({
          id: 'a1',
          label: 'coder agent',
          createdAt: t,
          message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
        }),
        makeRow({
          id: 'a2',
          label: 'coder agent',
          createdAt: t + 1000,
          message: assistantText('a2', 'running'),
        }),
      ];

      render(
        <MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder   Agent'])} />
      );

      const turn = screen.getByTestId('minimal-thread-turn');
      expect(turn.dataset.turnState).toBe('active');
    });
  });

  it('renders thinking-block entries with a distinct visual treatment', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
      }),
    ];

    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        {
          kind: 'thinking',
          preview: 'Considering the edge case where the cache is cold',
          ts: t,
          uuid: 'a1',
        },
        { kind: 'tool_use', toolName: 'Bash', preview: 'ls', ts: t, uuid: 'a1' },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );
    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries.length).toBe(2);
    expect(entries[0].dataset.rosterKind).toBe('thinking');
    expect(entries[0].textContent).toContain('Considering the edge case');
    expect(entries[0].querySelector('svg')).not.toBeNull();
    expect(entries[0].querySelector('.line-clamp-3')).not.toBeNull();
    expect(entries[1].dataset.rosterKind).toBe('tool');
  });

  it('renders tool roster entries with SDK labels, icons, and compact summaries', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [
          { name: 'mcp__node-agent__send_message', input: { message: 'raw payload' } },
        ]),
      }),
    ];

    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        {
          kind: 'tool_use',
          toolName: 'mcp__node-agent__send_message',
          preview: '',
          ts: t,
          uuid: 'mcp',
        },
        {
          kind: 'tool_use',
          toolName: 'TodoWrite',
          preview: 'Running: Running validation',
          ts: t + 1,
          uuid: 'todo',
        },
        {
          kind: 'tool_use',
          toolName: 'AskUserQuestion',
          preview: 'Which validation path should run?',
          ts: t + 2,
          uuid: 'question',
        },
        {
          kind: 'tool_use',
          toolName: 'MultiEdit',
          preview: 'MinimalThreadFeed.tsx',
          ts: t + 3,
          uuid: 'multi-edit',
        },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries.map((entry) => entry.dataset.rosterKind)).toEqual([
      'tool',
      'tool',
      'tool',
      'tool',
    ]);
    expect(entries[0].textContent).toContain('node-agent send_message');
    expect(entries[0].textContent).not.toContain('mcp__node-agent__send_message');
    expect(entries[0].querySelector('svg')).not.toBeNull();
    expect(entries[1].textContent).toContain('Todo');
    expect(entries[1].textContent).toContain('Running: Running validation');
    expect(entries[1].querySelector('svg')).not.toBeNull();
    expect(entries[2].textContent).toContain('AskUserQuestion');
    expect(entries[2].textContent).toContain('Which validation path should run?');
    expect(entries[3].textContent).toContain('Multi Edit');
    expect(entries[3].textContent).toContain('MinimalThreadFeed.tsx');
  });

  it('renders synthetic agent-handoff entries distinctly from real human messages', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
      }),
    ];

    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        { kind: 'user_message', text: 'please retry that step', ts: t, uuid: 'u1' },
        {
          kind: 'agent_handoff',
          text: 'Reviewer Agent: please verify the fix',
          ts: t + 1,
          uuid: 'h1',
        },
        { kind: 'tool_use', toolName: 'Bash', preview: 'ls', ts: t + 2, uuid: 'a1' },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries.length).toBe(3);

    expect(entries[0].dataset.rosterKind).toBe('user');
    expect(entries[0].textContent).toContain('please retry that step');

    expect(entries[1].dataset.rosterKind).toBe('handoff');
    expect(entries[1].textContent).toContain('Reviewer Agent');

    expect(entries[2].dataset.rosterKind).toBe('tool');
  });

  it('falls back to an empty roster when no summary covers the active session', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
        sessionId: 'space:s:task:t',
      }),
    ];

    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:other-task:o',
      turnIndex: 1,
      entries: [
        { kind: 'tool_use', toolName: 'Bash', preview: 'should not show', ts: t, uuid: 'x1' },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );
    expect(screen.queryByTestId('minimal-thread-roster-entry')).toBeNull();
    expect(screen.getByTestId('minimal-thread-active-rail')).toBeTruthy();
  });

  it('uses the latest session id for active summary lookup and active open affordance', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantText('a1', 'earlier text'),
        sessionId: 'space:s:old:task:t',
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: assistantToolUse('a2', [{ name: 'Bash', input: { command: 'bun test' } }]),
        sessionId: 'space:s:new:task:t',
      }),
    ];
    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:new:task:t',
      turnIndex: 1,
      entries: [
        { kind: 'tool_use', toolName: 'Bash', preview: 'bun test', ts: t + 1000, uuid: 'a2' },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    expect(screen.getByText(/bun test/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('minimal-thread-agent-open'));
    expect(mockPushOverlayHistory).toHaveBeenCalledWith(
      'space:s:new:task:t',
      'Coder Agent',
      undefined
    );
  });

  it('keeps completed stats aligned with a matching transition summary and result timestamp', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantText('a1', 'visible final text'),
        sessionId: 'space:s:task:t',
        turnIndex: 1,
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 2000,
        message: resultMessage('r1', 'visible final text'),
        sessionId: 'space:s:task:t',
        turnIndex: 1,
      }),
    ];
    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        { kind: 'tool_use', toolName: 'Bash', preview: 'one', ts: t, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'two', ts: t + 1, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'three', ts: t + 2, uuid: 'a1' },
      ],
    };

    render(<MinimalThreadFeed parsedRows={rows} activeTurnSummaries={[summary]} />);
    const meta = screen.getByTestId('minimal-thread-agent-meta');
    expect(meta.textContent).toContain('3 tool calls');
    expect(meta.textContent).toContain('2 messages');
    expect(meta.textContent).toContain('2s');
  });

  it('does not apply an active summary to an older completed turn in the same session', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'old-a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('old-a1', [{ name: 'Bash', input: { command: 'old only' } }]),
        sessionId: 'space:s:task:t',
        turnIndex: 1,
      }),
      makeRow({
        id: 'old-r1',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: resultMessage('old-r1', 'old complete'),
        sessionId: 'space:s:task:t',
        turnIndex: 1,
      }),
      makeRow({
        id: 'new-a1',
        label: 'Coder Agent',
        createdAt: t + 2000,
        message: assistantText('new-a1', 'new active turn'),
        sessionId: 'space:s:task:t',
        turnIndex: 2,
      }),
    ];
    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 2,
      entries: [
        { kind: 'tool_use', toolName: 'Bash', preview: 'one', ts: t + 2000, uuid: 'new-a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'two', ts: t + 2001, uuid: 'new-a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'three', ts: t + 2002, uuid: 'new-a1' },
      ],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );
    const completedMeta = screen.getByTestId('minimal-thread-agent-meta');
    expect(completedMeta.textContent).toContain('1 tool call');
    expect(completedMeta.textContent).not.toContain('3 tool calls');
    expect(screen.getByTestId('minimal-thread-active-meta').textContent).toContain('⚙ 3');
  });

  it('only applies summary-derived completed counts to the final result slice', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'early only' } }]),
        sessionId: 'space:s:task:t',
        turnIndex: 1,
      }),
      makeRow({
        id: 'a1-text',
        label: 'Coder Agent',
        createdAt: t + 500,
        message: assistantText('a1-text', 'paused before handoff'),
        sessionId: 'space:s:task:t',
        turnIndex: 1,
      }),
      makeRow({
        id: 'handoff',
        label: 'Coder Agent',
        createdAt: t + 1000,
        message: replayUserMessage('handoff', 'please continue'),
        sessionId: 'space:s:task:t',
        turnIndex: 1,
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 2000,
        message: assistantText('a2', 'finished after handoff'),
        sessionId: 'space:s:task:t',
        turnIndex: 1,
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 3000,
        message: resultMessage('r1', 'finished after handoff'),
        sessionId: 'space:s:task:t',
        turnIndex: 1,
      }),
    ];
    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        { kind: 'tool_use', toolName: 'Bash', preview: 'one', ts: t, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'two', ts: t + 1, uuid: 'a1' },
        { kind: 'tool_use', toolName: 'Bash', preview: 'three', ts: t + 2, uuid: 'a1' },
      ],
    };

    render(<MinimalThreadFeed parsedRows={rows} activeTurnSummaries={[summary]} />);
    const metas = screen.getAllByTestId('minimal-thread-agent-meta');
    expect(metas[0].textContent).toContain('1 tool call');
    expect(metas[0].textContent).not.toContain('3 tool calls');
    expect(metas[1].textContent).toContain('3 tool calls');
  });

  it.each([
    ['compacting', 'Compacting…'],
    ['requesting', 'Requesting…'],
  ] as const)('folds %s status into the active turn header and roster', (status, expectedText) => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 's1',
        label: 'Coder Agent',
        createdAt: t + 100,
        messageType: 'system',
        message: statusMessage('s1', status),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);

    expect(screen.queryByTestId('minimal-thread-system')).toBeNull();

    const turn = screen.getByTestId('minimal-thread-turn');
    expect(turn.dataset.turnState).toBe('active');

    const pill = screen.getByTestId('minimal-thread-status-pill');
    expect(pill.dataset.status).toBe(expectedText);
    expect(pill.textContent).toContain(expectedText);

    const statusEntry = screen.getByTestId('minimal-thread-roster-entry');
    expect(statusEntry.dataset.rosterKind).toBe('status');
    expect(statusEntry.dataset.status).toBe(status);
    expect(statusEntry.textContent).toContain(expectedText);
  });

  it('clears folded status when SDK sends status: null', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 's1',
        label: 'Coder Agent',
        createdAt: t + 100,
        messageType: 'system',
        message: statusMessage('s1', 'compacting'),
      }),
      makeRow({
        id: 's2',
        label: 'Coder Agent',
        createdAt: t + 200,
        messageType: 'system',
        message: statusClearMessage('s2'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);

    expect(screen.queryByTestId('minimal-thread-system')).toBeNull();

    const turn = screen.getByTestId('minimal-thread-turn');
    expect(turn.dataset.turnState).toBe('active');

    const pill = screen.getByTestId('minimal-thread-status-pill');
    expect(pill.dataset.status).toBe('Running…');
    expect(pill.textContent).toContain('Running…');

    expect(screen.queryByTestId('minimal-thread-roster-entry')).toBeNull();
  });

  it('keeps the first status when two status rows share the same timestamp', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 's1',
        label: 'Coder Agent',
        createdAt: t,
        messageType: 'system',
        message: statusMessage('s1', 'compacting'),
      }),
      makeRow({
        id: 's2',
        label: 'Coder Agent',
        createdAt: t,
        messageType: 'system',
        message: statusMessage('s2', 'requesting'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);

    const pill = screen.getByTestId('minimal-thread-status-pill');
    expect(pill.dataset.status).toBe('Compacting…');

    const statusEntry = screen.getByTestId('minimal-thread-roster-entry');
    expect(statusEntry.dataset.status).toBe('compacting');
  });

  it('clears compacting status when a compact boundary arrives for the active turn', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
      }),
      makeRow({
        id: 's1',
        label: 'Coder Agent',
        createdAt: t + 100,
        messageType: 'system',
        message: statusMessage('s1', 'compacting'),
      }),
      makeRow({
        id: 'cb1',
        label: 'Coder Agent',
        createdAt: t + 200,
        messageType: 'system',
        message: compactBoundaryMessage('cb1', {
          trigger: 'auto',
          pre_tokens: 1000,
          post_tokens: 500,
        }),
      }),
      makeRow({
        id: 'a2',
        label: 'Coder Agent',
        createdAt: t + 300,
        message: assistantToolUse('a2', [{ name: 'Read', input: { file_path: 'x.ts' } }]),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);

    const turns = screen.getAllByTestId('minimal-thread-turn');
    const activeTurn = turns.find((el) => el.dataset.turnState === 'active');
    expect(activeTurn).not.toBeUndefined();

    const pill = screen.getByTestId('minimal-thread-status-pill');
    expect(pill.dataset.status).toBe('Running…');

    const statusEntries = screen.queryAllByTestId('minimal-thread-roster-entry');
    expect(statusEntries.some((el) => el.dataset.rosterKind === 'status')).toBe(false);
  });

  it('does not consume a status row when there is no fold target', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 's1',
        label: 'Coder Agent',
        createdAt: t,
        messageType: 'system',
        message: statusMessage('s1', 'requesting'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);

    const systemRows = screen.getAllByTestId('minimal-thread-system');
    expect(systemRows).toHaveLength(1);
    expect(systemRows[0].textContent).toContain('Requesting');
    expect(screen.queryByTestId('minimal-thread-status-pill')).toBeNull();
  });

  it('does not fold a status row from a different session onto the active rail', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
        sessionId: 'active-session',
      }),
      makeRow({
        id: 's1',
        label: 'Coder Agent',
        createdAt: t + 100,
        sessionId: 'other-session',
        messageType: 'system',
        message: statusMessage('s1', 'requesting', 'other-session'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} activeAgentLabels={new Set(['Coder Agent'])} />);

    const systemRows = screen.getAllByTestId('minimal-thread-system');
    expect(systemRows).toHaveLength(1);
    expect(systemRows[0].textContent).toContain('Requesting');

    const pill = screen.getByTestId('minimal-thread-status-pill');
    expect(pill.dataset.status).toBe('Running…');
  });

  it('does not let an unmatched clear status from another session steal the active turn session', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'bun test' } }]),
        sessionId: 'active-session',
      }),
      makeRow({
        id: 'clear1',
        label: 'Coder Agent',
        createdAt: t + 100,
        sessionId: 'other-session',
        messageType: 'system',
        message: statusClearMessage('clear1', 'other-session'),
      }),
    ];
    const summary: ActiveTurnSummary = {
      sessionId: 'active-session',
      turnIndex: 0,
      entries: [{ kind: 'tool_use', toolName: 'Read', preview: 'summary-read', ts: t, uuid: 'a1' }],
    };

    render(
      <MinimalThreadFeed
        parsedRows={rows}
        activeAgentLabels={new Set(['Coder Agent'])}
        activeTurnSummaries={[summary]}
      />
    );

    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries.some((el) => el.textContent?.includes('summary-read'))).toBe(true);

    expect(screen.queryByTestId('minimal-thread-system')).toBeNull();

    const pill = screen.getByTestId('minimal-thread-status-pill');
    expect(pill.dataset.status).toBe('Running…');
  });

  it('does not consume a status row when the agent is not rendering an active rail', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantText('a1', 'done'),
        sessionId: 'active-session',
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 100,
        message: resultMessage('r1'),
        sessionId: 'active-session',
      }),
      makeRow({
        id: 's1',
        label: 'Coder Agent',
        createdAt: t + 200,
        sessionId: 'active-session',
        messageType: 'system',
        message: statusMessage('s1', 'compacting', 'active-session'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    const systemRows = screen.getAllByTestId('minimal-thread-system');
    expect(systemRows).toHaveLength(1);
    expect(systemRows[0].textContent).toContain('Compacting');

    expect(screen.queryByTestId('minimal-thread-status-pill')).toBeNull();
  });

  it('falls back to a system row for compacting status when no active turn exists', () => {
    const t = Date.now();
    const rows = [
      makeRow({
        id: 'a1',
        label: 'Coder Agent',
        createdAt: t,
        message: assistantText('a1', 'done'),
      }),
      makeRow({
        id: 'r1',
        label: 'Coder Agent',
        createdAt: t + 100,
        message: resultMessage('r1'),
      }),
      makeRow({
        id: 's1',
        label: 'Coder Agent',
        createdAt: t + 200,
        messageType: 'system',
        message: statusMessage('s1', 'compacting'),
      }),
    ];

    render(<MinimalThreadFeed parsedRows={rows} />);

    const systemRows = screen.getAllByTestId('minimal-thread-system');
    expect(systemRows).toHaveLength(1);
    expect(systemRows[0].textContent).toContain('Compacting');
    expect(systemRows[0].textContent).toContain('compacting');
    expect(screen.queryByTestId('minimal-thread-status-pill')).toBeNull();
  });
});
