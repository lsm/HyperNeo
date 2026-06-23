import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveTurnSummary } from '@neokai/shared';
import { parseThreadRow } from '../space-task-thread-events';
import { MinimalThreadFeed } from './MinimalThreadFeed';

const mockPushOverlayHistory = vi.hoisted(() => vi.fn());

// Stub MarkdownRenderer to a synchronous text renderer so tests can assert
// content without waiting on the lazy-loaded marked import.
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
  // Replay messages have isReplay: true and may carry no origin metadata —
  // the agent→agent handoff case the daemon currently emits.
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
  // Minimal `system:init` envelope. ResultInfoDropdown / MessageInfoDropdown
  // only require the discriminator fields to render the affordance trigger;
  // detailed-shape coverage lives in the component-level tests.
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

    // Hidden subtypes (session_state_changed, commands_changed) are suppressed
    // via isHiddenSystemSubtype; only thinking_tokens, model_fallback, and the
    // warning notice render.
    const systemRows = screen.getAllByTestId('minimal-thread-system');
    expect(systemRows).toHaveLength(3);
    expect(systemRows[0].textContent).toContain('Thinking tokens');
    expect(systemRows[0].textContent).toContain('1,250 estimated tokens (+25)');
    expect(systemRows[1].textContent).toContain('Model fallback');
    expect(systemRows[1].textContent).toContain('Retried with fallback model');
    expect(systemRows[1].textContent).toContain('claude-opus-4-5 -> claude-sonnet-4-5');
    expect(systemRows[2].textContent).toContain('Warning');
    expect(systemRows[2].textContent).toContain('Hook warning shown to the user');
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
    // Names appear in their short uppercase form.
    expect(turns[0].textContent).toContain('CODER');
    expect(turns[1].textContent).toContain('REVIEWER');
    // Both blocks contain a result row → both rendered as completed turns.
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
    // Doesn't pick the earlier text once a later assistant text exists.
    expect(screen.queryByText('preliminary')).toBeNull();
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

    // Server-derived summary: same activity as the parsed rows would produce
    // under the old client-side derivation, but expressed as the wire shape
    // (`ActivityEntry[]`) the renderer now consumes.
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

    // Rail wrapper appears only on active turns.
    expect(screen.getByTestId('minimal-thread-active-rail')).toBeTruthy();

    // All four tool entries appear in the roster.
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

    // Status text sits in the active header while the rail shows richer live stats.
    expect(turn.textContent).toContain('Running');
    const rail = screen.getByTestId('minimal-thread-active-rail');
    expect(rail.textContent).not.toContain('Running');
    expect(screen.getByTestId('minimal-thread-active-meta').textContent).toContain('⚙ 4');
    expect(turn.textContent).toContain('2 messages');
    expect(screen.getByTestId('minimal-thread-last-event').textContent).toContain('last event');
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

    // No standalone task_notification system row — it's folded onto the roster.
    expect(screen.queryByText('Task completed')).toBeNull();
    const entries = screen.getAllByTestId('minimal-thread-roster-entry');
    expect(entries[0].dataset.taskStatus).toBe('completed');
    expect(entries[0].textContent).toContain('42 tests passed');
  });

  it('does not fold when the summary turnIndex is stale vs the compact rows turn', () => {
    const t = Date.now();
    // Compact rows are on turn 1 (active). The summary claims turn 2 — a stale
    // delta from the previous turn. Its tool_use_id must NOT suppress the
    // notification (no matching rendered turn → fallback row).
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

    // Turn mismatch → not folded → notification falls back to a row.
    const feed = screen.getByTestId('space-task-event-feed-minimal');
    expect(feed.textContent).toContain('42 tests passed');
    expect(feed.textContent).toContain('Task completed');
  });

  it('drops the active roster when the summary turnIndex mismatches the trailing turn', () => {
    const t = Date.now();
    // Active turn on turn 1, but the summary claims turn 2 (stale active-turn
    // delta). buildActiveTurn must not fold the stale tool/status onto the rail.
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

    // Turn is still active, but the stale-turn summary yields no roster entries.
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

  it('falls back to a system row for task_notification with no roster target (completed turn)', () => {
    const t = Date.now();
    // More than ROSTER_MAX_ENTRIES tool_use blocks → the first tool is capped
    // out of the completed roster. Its notification must remain standalone so
    // terminal metadata is not lost.
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

    // Capped out of the completed roster → notification renders as a row,
    // preserving both summary and usage (terminal metadata not lost).
    const feed = screen.getByTestId('space-task-event-feed-minimal');
    expect(feed.textContent).toContain('Bash exited 1');
    expect(feed.textContent).toContain('4,321 tokens');
    expect(feed.textContent).toContain('3 tool uses');
  });

  it('falls back to a row when a stale summary lingers after the turn went terminal', () => {
    const t = Date.now();
    // Tool_use + result → terminal turn, but the active-turn LiveQuery still
    // holds a summary for it (stale). The notification must NOT be suppressed,
    // because no active roster renders for a terminal trailing block.
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

    // Stale summary is ignored (terminal trailing block) → notification falls back to a row.
    const feed = screen.getByTestId('space-task-event-feed-minimal');
    expect(feed.textContent).toContain('all green');
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

    // 10 tool entries in the active-turn summary — only the last 8 should render.
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
    // The very oldest two were trimmed.
    expect(entries[0].textContent).not.toContain('echo 1');
    expect(entries[0].textContent).not.toContain('echo 2');
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
    // No result message — block is non-terminal. Need an assistant text row
    // alongside the tool-use so the completed turn has surfaceable text and
    // is not dropped by the empty-completed-turn filter.
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
    // One message turn + one agent turn.
    expect(turns.length).toBe(2);

    const messageTurn = turns[0];
    expect(messageTurn.dataset.turnState).toBe('message');
    expect(messageTurn.dataset.fromLabel).toBe('User');
    expect(messageTurn.dataset.toLabel).toBe('Coder Agent');
    // Human bubbles are iMessage-style — sender labels are encoded on the
    // dataset (asserted above) but not surfaced as visible text.
    expect(messageTurn.dataset.messageKind).toBe('human');
    await waitFor(() => {
      expect(screen.getByText('help me add dark mode')).toBeTruthy();
    });

    // Agent turn follows.
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
    // Synthetic handoffs render with a "Synthetic" badge (was "handoff" earlier;
    // renamed when the bubble was redesigned to mirror the Thinking block).
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
      // Reviewer ran first.
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
      // Synthetic handoff lands in Coder's session with no origin info.
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
    // Reviewer agent turn → message turn (handoff) → Coder agent turn.
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
    // 1 tool call, 3 messages, ~31s duration.
    expect(turn.textContent).toContain('1 tool call');
    expect(turn.textContent).toContain('3 messages');

    // The meta line lives in the header under the agent name now —
    // outside the reply bubble so it reads as "subtitle of the turn"
    // rather than "first line of the agent's reply".
    const meta = screen.getByTestId('minimal-thread-agent-meta');
    expect(meta).toBeTruthy();
    expect(meta.textContent).toContain('1 tool call');
    expect(meta.textContent).toContain('3 messages');

    // Assert the meta line is NOT inside the agent reply bubble.
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

    // Sequence: text → tool → text → tool. All four entries should appear
    // in the roster in order, with kinds tagged on the data attribute.
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

    // Server is the canonical filter — but the renderer also defensively
    // drops empty text/thinking entries so a future relaxation upstream
    // can't bleed whitespace into the rail.
    const summary: ActiveTurnSummary = {
      sessionId: 'space:s:task:t',
      turnIndex: 1,
      entries: [
        { kind: 'text', text: '   ', ts: t, uuid: 'a1' }, // whitespace-only
        { kind: 'text', text: '', ts: t, uuid: 'a1' }, // empty string
        { kind: 'thinking', preview: '', ts: t, uuid: 'a1' }, // empty thinking
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
      // The trigger button has title="Run result" (see ResultInfoButton).
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
        // No result row → no envelope.
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
      // Both human msg and agent reply share the same block init, so we
      // expect to see the session-info trigger present at least once.
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
      // `isError` flag wires the amber accent class onto the trigger so
      // failures surface in the actions row before the dropdown opens.
      expect(trigger?.className).toMatch(/amber/);
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

    // 10 mixed entries — only the last 8 should render.
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
    // Oldest two trimmed.
    expect(allText).not.toContain('msg-1');
    expect(allText).not.toContain('echo 1');
    // Latest eight kept.
    expect(allText).toContain('msg-2');
    expect(allText).toContain('echo 2');
    expect(allText).toContain('msg-5');
    expect(allText).toContain('echo 5');
  });

  describe('Per-agent active rail (multi-session)', () => {
    // In a multi-session workflow (e.g. Coder + Reviewer in the Coding
    // Workflow), agent rows interleave. With the original "globally
    // trailing block" check, a Reviewer terminal `result` row landing
    // after Coder's last visible row would suppress Coder's still-
    // running rail because the global tail is now terminal. The fix
    // is to track trailing non-terminal blocks per agent label.
    it('keeps the Coder rail active when Reviewer just emitted a terminal result after Coder', () => {
      const t = Date.now();
      const rows = [
        // Coder is mid-action — assistant rows but no result yet.
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
        // Reviewer ran briefly and just finished — its terminal `result`
        // row lands AFTER Coder's last row. Pre-fix, this is what
        // suppressed Coder's rail.
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
      // Coder turn first, Reviewer turn second.
      const coderTurn = turns.find((t) => t.dataset.agentLabel === 'Coder Agent');
      const reviewerTurn = turns.find((t) => t.dataset.agentLabel === 'Reviewer Agent');
      expect(coderTurn?.dataset.turnState).toBe('active');
      expect(reviewerTurn?.dataset.turnState).toBe('completed');
      // Exactly one rail — Coder's.
      expect(screen.getAllByTestId('minimal-thread-active-rail').length).toBe(1);
    });

    it('mirrors: keeps the Reviewer rail active when Coder just finished before Reviewer', () => {
      const t = Date.now();
      const rows = [
        // Coder fully ran and emitted a terminal result.
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
        // Reviewer is mid-action — assistant rows, no result yet.
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
        // Coder mid-action — non-terminal.
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
        // Reviewer mid-action — also non-terminal.
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
      // Two rails — one per agent.
      expect(screen.getAllByTestId('minimal-thread-active-rail').length).toBe(2);
    });

    it('matches active-agent labels case- and whitespace-insensitively', () => {
      // Activity members are run through a title-casing helper on the
      // daemon ("coder agent" → "Coder Agent") while raw row labels
      // can be either form. The renderer should treat them as the
      // same agent regardless of casing or extra whitespace.
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

    // First entry: real human user input — distinct kind data attribute.
    expect(entries[0].dataset.rosterKind).toBe('user');
    expect(entries[0].textContent).toContain('please retry that step');

    // Second entry: synthetic agent→agent handoff — uses its own kind, NOT
    // the same `user` kind, so the rail can render the visual distinction.
    expect(entries[1].dataset.rosterKind).toBe('handoff');
    expect(entries[1].textContent).toContain('Reviewer Agent');

    // Third entry: tool — confirms the handoff/user entries don't displace
    // or break the existing tool rendering.
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

    // Summary keyed on a different session id — the trailing block's
    // session id has no match, so the rail renders empty rather than
    // surfacing stale activity from another session.
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
    // Active rail is still present (the block IS active) — it just has
    // no entries.
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
});
