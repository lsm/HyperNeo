// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { render, fireEvent, waitFor } from '@testing-library/preact';
import { SDKMessageRenderer } from '../SDKMessageRenderer';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { UUID } from 'crypto';

const createUUID = (): UUID => crypto.randomUUID() as UUID;

function createUserMessage(content: string): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: content,
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

function createAssistantMessage(textContent: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: textContent }],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function createResultMessage(success: boolean): SDKMessage {
  const base = {
    type: 'result' as const,
    duration_ms: 1000,
    duration_api_ms: 900,
    is_error: !success,
    num_turns: 1,
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: createUUID(),
    session_id: 'test-session',
  };

  if (success) {
    return {
      ...base,
      subtype: 'success',
      result: 'Operation completed',
    } as unknown as SDKMessage;
  }
  return {
    ...base,
    subtype: 'error_during_execution',
    errors: ['Something went wrong'],
  } as unknown as SDKMessage;
}

function createSystemInitMessage(): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    agents: [],
    apiKeySource: 'user',
    betas: [],
    claude_code_version: '1.0.0',
    cwd: '/test/path',
    tools: ['Read', 'Write', 'Bash'],
    mcp_servers: [],
    model: 'claude-3-5-sonnet-20241022',
    permissionMode: 'default',
    slash_commands: ['help', 'clear'],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

function createToolProgressMessage(): SDKMessage {
  return {
    type: 'tool_progress',
    tool_use_id: 'toolu_test123',
    tool_name: 'Read',
    parent_tool_use_id: null,
    elapsed_time_seconds: 2.5,
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

function createStreamEventMessage(): SDKMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function createAuthStatusMessage(): SDKMessage {
  return {
    type: 'auth_status',
    isAuthenticating: true,
    output: ['Authenticating...'],
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

function createSubagentMessage(): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_subagent',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Subagent response' }],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: 'toolu_parent123',
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function createUserReplayMessage(): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: '<local-command-stdout>Command output</local-command-stdout>',
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: 'test-session',
    isReplay: true,
  };
}

function createSystemCompactBoundaryMessage(): SDKMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    summary: 'Conversation compacted to save context',
    compact_metadata: {
      trigger: 'automatic',
      pre_tokens: 50000,
      post_tokens: 10000,
    },
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

describe('SDKMessageRenderer', () => {
  describe('Message Type Routing', () => {
    it('should render user message', () => {
      const message = createUserMessage('Hello world');
      const { container } = render(<SDKMessageRenderer message={message} />);

      const userMessage = container.querySelector('[data-testid="user-message"]');
      expect(userMessage).toBeTruthy();
    });

    it('should render system message (compact boundary)', () => {
      const message = createSystemCompactBoundaryMessage();
      const { container } = render(<SDKMessageRenderer message={message} />);

      expect(container.textContent).toContain('Compact');
      expect(container.textContent).toContain('tokens');
    });

    it('should render hidden subtypes as null (thinking_tokens)', () => {
      const message = {
        type: 'system',
        subtype: 'thinking_tokens',
        estimated_tokens: 12345,
        estimated_tokens_delta: 678,
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as SDKMessage;

      const { container } = render(<SDKMessageRenderer message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('should render all hidden system subtypes as null', () => {
      for (const subtype of [
        'session_state_changed',
        'commands_changed',
        'task_started',
        'task_progress',
        'task_updated',
        'mirror_error',
        'elicitation_complete',
      ]) {
        const message = {
          type: 'system',
          subtype,
          state: 'requires_action',
          uuid: createUUID(),
          session_id: 'test-session',
        } as unknown as SDKMessage;

        const { container } = render(<SDKMessageRenderer message={message} />);

        expect(container.innerHTML).toBe('');
      }
    });

    it('should render worker shutdown messages only at the live tail', () => {
      const message = {
        type: 'system',
        subtype: 'worker_shutting_down',
        reason: 'host_exit',
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as SDKMessage;

      const stale = render(<SDKMessageRenderer message={message} />);
      expect(stale.container.textContent).not.toContain('Worker shutting down');

      const liveTail = render(<SDKMessageRenderer message={message} isLiveTail={true} />);
      expect(liveTail.container.textContent).toContain('Worker shutting down');
      expect(liveTail.container.textContent).toContain('host_exit');
    });

    it('should render assistant message', () => {
      const message = createAssistantMessage('Hi there!');
      const { container } = render(<SDKMessageRenderer message={message} />);

      const assistantMessage = container.querySelector('[data-testid="assistant-message"]');
      expect(assistantMessage).toBeTruthy();
    });

    it('should visually mark superseded messages without hiding them', () => {
      const message = createUserMessage('Old message');
      const { container } = render(
        <SDKMessageRenderer message={message} replacementStatus="superseded" />
      );

      expect(container.textContent).toContain('Superseded by replacement');
      expect(container.textContent).toContain('Old message');
      expect(
        container.querySelector('[data-message-replacement-status="superseded"]')
      ).toBeTruthy();
    });

    it('should visually mark retracted messages without hiding them', () => {
      const message = createUserMessage('Retracted message');
      const { container } = render(
        <SDKMessageRenderer message={message} replacementStatus="retracted" />
      );

      expect(container.textContent).toContain('Retracted by fallback');
      expect(container.textContent).toContain('Retracted message');
      expect(container.querySelector('[data-message-replacement-status="retracted"]')).toBeTruthy();
    });

    it('should not wrap hidden tool-result user rows with replacement markers', () => {
      const message = {
        type: 'user',
        uuid: createUUID(),
        session_id: 'test-session',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-use-123',
              content: 'Retracted tool output',
            },
          ],
        },
      } as unknown as SDKMessage;

      const { container } = render(
        <SDKMessageRenderer message={message} replacementStatus="retracted" />
      );

      expect(container.textContent).toBe('');
      expect(container.querySelector('[data-message-replacement-status="retracted"]')).toBeFalsy();
    });

    it('should render result message', () => {
      const message = createResultMessage(true);
      const { container } = render(<SDKMessageRenderer message={message} />);

      const resultMessage = container.querySelector('button');
      expect(resultMessage).toBeTruthy();
      expect(container.textContent).toContain('tokens');
    });

    it('should render tool progress message', () => {
      const message = createToolProgressMessage();
      const { container } = render(<SDKMessageRenderer message={message} />);

      expect(container.textContent).toContain('Read');
    });

    it('should render auth status message', () => {
      const message = createAuthStatusMessage();
      const { container } = render(<SDKMessageRenderer message={message} />);

      expect(container.textContent).toContain('Authenticating');
    });

    it('should render prompt suggestion message', () => {
      const message = {
        type: 'prompt_suggestion',
        suggestion: 'Add unit tests for the renderer',
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as SDKMessage;

      const { container } = render(<SDKMessageRenderer message={message} />);

      expect(container.querySelector('[data-testid="prompt-suggestion"]')).toBeTruthy();
      expect(container.textContent).toContain('Add unit tests for the renderer');
      expect(container.textContent).not.toContain('Unknown message type');
    });

    it('should render tool use summary message', () => {
      const message = {
        type: 'tool_use_summary',
        summary: 'Searched the codebase for renderers',
        preceding_tool_use_ids: ['toolu_first', 'toolu_second'],
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as SDKMessage;

      const { container } = render(<SDKMessageRenderer message={message} />);

      expect(container.querySelector('[data-testid="tool-use-summary"]')).toBeTruthy();
      expect(container.textContent).toContain('Searched the codebase for renderers');
      expect(container.textContent).toContain('2 tool uses');
      expect(container.textContent).not.toContain('Unknown message type');
    });

    it('should render user replay message (slash command response)', async () => {
      const message = createUserReplayMessage();
      const { container } = render(<SDKMessageRenderer message={message} />);

      await waitFor(() => {
        expect(container.textContent).toContain('Command output');
      });
    });
  });

  describe('Filtering Logic', () => {
    it('should skip stream events (not user visible)', () => {
      const message = createStreamEventMessage();
      const { container } = render(<SDKMessageRenderer message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('should skip system init messages (shown as indicators)', () => {
      const message = createSystemInitMessage();
      const { container } = render(<SDKMessageRenderer message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('should skip subagent messages (shown inside SubagentBlock)', () => {
      const message = createSubagentMessage();
      const { container } = render(<SDKMessageRenderer message={message} />);

      expect(container.innerHTML).toBe('');
    });

    it('should skip agent_id-scoped permission_denied messages nested under a Task', () => {
      const message = {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        agent_id: 'toolu_parent123',
        message: 'Auto-denied by mode',
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as SDKMessage;

      const subagentMessagesMap = new Map<string, SDKMessage[]>([['toolu_parent123', [message]]]);

      const { container } = render(
        <SDKMessageRenderer message={message} subagentMessagesMap={subagentMessagesMap} />
      );

      expect(container.innerHTML).toBe('');
    });
  });

  describe('Props Passing', () => {
    it('should pass toolResultsMap to assistant message', () => {
      const message = createAssistantMessage('Testing with tools');
      const toolResultsMap = new Map([['toolu_test', { content: 'Tool result' }]]);

      const { container } = render(
        <SDKMessageRenderer message={message} toolResultsMap={toolResultsMap} />
      );

      expect(container.querySelector('[data-testid="assistant-message"]')).toBeTruthy();
    });

    it('should pass sessionInfo to user message', () => {
      const message = createUserMessage('Hello');
      const sessionInfo = createSystemInitMessage() as Extract<
        SDKMessage,
        { type: 'system'; subtype: 'init' }
      >;

      const { container } = render(
        <SDKMessageRenderer message={message} sessionInfo={sessionInfo} />
      );

      expect(container.querySelector('[data-testid="user-message"]')).toBeTruthy();
    });

    it('should pass toolInput to tool progress message', () => {
      const message = createToolProgressMessage();
      const toolInputsMap = new Map([['toolu_test123', { file_path: '/test/file.txt' }]]);

      const { container } = render(
        <SDKMessageRenderer message={message} toolInputsMap={toolInputsMap} />
      );

      expect(container.textContent).toContain('Read');
    });
  });

  describe('task_notification folding', () => {
    const baseNotification = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      tool_use_id: 'tu-fold',
      status: 'completed' as const,
      output_file: '/tmp/out.txt',
      summary: 'Bash exited 0',
      uuid: createUUID(),
      session_id: 'test-session',
    };

    it('suppresses the row when its tool_use card is rendered in the slice', () => {
      const message = { ...baseNotification } as unknown as SDKMessage;

      const { container } = render(
        <SDKMessageRenderer message={message} foldableToolUseIds={new Set(['tu-fold'])} />
      );

      expect(container.innerHTML).toBe('');
    });

    it('folds a top-level Bash task_notification onto an in-slice Bash card', () => {
      const toolUseId = 'toolu_bash_in_slice';
      const notification = {
        ...baseNotification,
        tool_use_id: toolUseId,
        summary: 'Command completed',
      } as unknown as SDKMessage;
      const assistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_bash_tool_use',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: toolUseId,
              name: 'Bash',
              input: { command: 'echo ok', description: 'Command completed' },
            },
          ],
          model: 'claude-3-5-sonnet-20241022',
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        parent_tool_use_id: null,
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as SDKMessage;
      const taskNotificationsMap = new Map([[toolUseId, notification]]);
      const foldableToolUseIds = new Set([toolUseId]);

      const { container } = render(
        <>
          <SDKMessageRenderer
            message={assistantMessage}
            taskNotificationsMap={taskNotificationsMap}
            foldableToolUseIds={foldableToolUseIds}
          />
          <SDKMessageRenderer message={notification} foldableToolUseIds={foldableToolUseIds} />
        </>
      );

      expect(container.textContent).not.toContain('Task completed');
      expect(container.querySelector('[aria-label="task completed"]')).toBeTruthy();
    });

    it('renders the fallback row when the tool_use is paginated out of the slice', () => {
      const message = { ...baseNotification } as unknown as SDKMessage;

      const { container } = render(
        <SDKMessageRenderer message={message} foldableToolUseIds={new Set()} />
      );

      expect(container.textContent).toContain('Task completed');
      expect(container.textContent).toContain('Bash exited 0');
    });

    it('renders the fallback row for a nested tool_use whose parent card is paginated out', () => {
      const message = { ...baseNotification } as unknown as SDKMessage;
      const { container } = render(
        <SDKMessageRenderer
          message={message}
          toolInputsMap={new Map([['tu-fold', { command: 'echo hi' }]])}
          foldableToolUseIds={new Set()}
        />
      );

      expect(container.textContent).toContain('Task completed');
      expect(container.textContent).toContain('Bash exited 0');
    });

    it('renders the fallback row for true orphans (no tool_use_id)', () => {
      const message = {
        ...baseNotification,
        tool_use_id: undefined,
        summary: 'standalone notice',
      } as unknown as SDKMessage;

      const { container } = render(<SDKMessageRenderer message={message} />);

      expect(container.textContent).toContain('standalone notice');
    });

    it('renders the fallback row for a nested notification whose parent card is absent', () => {
      const message = {
        ...baseNotification,
        parent_tool_use_id: 'task-missing',
      } as unknown as SDKMessage;

      const { container } = render(
        <SDKMessageRenderer message={message} foldableToolUseIds={new Set()} />
      );

      expect(container.textContent).toContain('Task completed');
      expect(container.textContent).toContain('Bash exited 0');
    });
  });

  describe('Unknown Message Types', () => {
    it('should render fallback for unknown message types', () => {
      const unknownMessage = {
        type: 'unknown_type',
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as SDKMessage;

      const { container } = render(<SDKMessageRenderer message={unknownMessage} />);

      expect(container.textContent).toContain('Unknown message type');
    });
  });

  describe('Error Message Handling', () => {
    it('should render error result message', () => {
      const message = createResultMessage(false);
      const { container } = render(<SDKMessageRenderer message={message} />);

      expect(container.querySelector('.bg-red-50, .bg-red-900\\/10')).toBeTruthy();
    });
  });

  describe('Normal Mode Rewind Icon', () => {
    const onRewind = vi.fn();

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should render rewind icon on hover for user message with uuid', () => {
      const message = createUserMessage('Hello');
      const { container } = render(
        <SDKMessageRenderer
          message={message}
          onRewind={onRewind}
          rewindingMessageUuid={null}
          sessionId="test-session"
        />
      );

      const rewindButton = container.querySelector('button[title="Rewind to here"]');
      expect(rewindButton).toBeTruthy();
    });

    it('should not render rewind icon for assistant message (only user messages have rewind)', () => {
      const message = createAssistantMessage('Hello there');
      const { container } = render(
        <SDKMessageRenderer
          message={message}
          onRewind={onRewind}
          rewindingMessageUuid={null}
          sessionId="test-session"
        />
      );

      const rewindButton = container.querySelector('button[title="Rewind to here"]');
      expect(rewindButton).toBeFalsy();
    });

    it('should call onRewind when rewind button is clicked', () => {
      const message = createUserMessage('Test');
      const { container } = render(
        <SDKMessageRenderer
          message={message}
          onRewind={onRewind}
          rewindingMessageUuid={null}
          sessionId="test-session"
        />
      );

      const rewindButton = container.querySelector('button[title="Rewind to here"]');
      fireEvent.click(rewindButton!);

      expect(onRewind).toHaveBeenCalledWith(message.uuid);
    });

    it('should show spinner when rewindingMessageUuid matches', () => {
      const message = createUserMessage('Test');
      const { container } = render(
        <SDKMessageRenderer
          message={message}
          onRewind={onRewind}
          rewindingMessageUuid={message.uuid}
          sessionId="test-session"
        />
      );

      const spinner = container.querySelector('[role="status"]');
      expect(spinner).toBeTruthy();

      const rewindButton = container.querySelector('button[title="Rewind to here"]');
      expect(rewindButton).toBeFalsy();
    });

    it('should not show rewind icon when sessionId is missing', () => {
      const message = createUserMessage('Test');
      const { container } = render(
        <SDKMessageRenderer message={message} onRewind={onRewind} rewindingMessageUuid={null} />
      );

      const rewindButton = container.querySelector('button[title="Rewind to here"]');
      expect(rewindButton).toBeFalsy();
    });

    it('should not show rewind icon when onRewind is missing', () => {
      const message = createUserMessage('Test');
      const { container } = render(
        <SDKMessageRenderer
          message={message}
          rewindingMessageUuid={null}
          sessionId="test-session"
        />
      );

      const rewindButton = container.querySelector('button[title="Rewind to here"]');
      expect(rewindButton).toBeFalsy();
    });
  });

  describe('No Rewind UI Cases', () => {
    const onRewind = vi.fn();

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should not show rewind UI for messages without uuid', () => {
      const message = createUserMessage('Test');
      // @ts-expect-error - Testing undefined uuid
      message.uuid = undefined;

      const { container } = render(
        <SDKMessageRenderer
          message={message}
          onRewind={onRewind}
          sessionId="test-session"
          rewindingMessageUuid={null}
        />
      );

      expect(container.querySelector('button[title="Rewind to here"]')).toBeFalsy();

      expect(container.querySelector('[data-testid="user-message"]')).toBeTruthy();
    });

    it('should show rewind UI for synthetic messages', () => {
      const message = {
        ...createUserMessage('Synthetic message'),
        isSynthetic: true,
      };

      const { container } = render(
        <SDKMessageRenderer
          message={message}
          onRewind={onRewind}
          sessionId="test-session"
          rewindingMessageUuid={null}
        />
      );

      expect(container.querySelector('button[title="Rewind to here"]')).toBeTruthy();
    });

    it('should not show rewind UI for result messages (only user messages have rewind)', () => {
      const message = createResultMessage(true);

      const { container } = render(
        <SDKMessageRenderer
          message={message}
          onRewind={onRewind}
          sessionId="test-session"
          rewindingMessageUuid={null}
        />
      );

      const rewindButton = container.querySelector('button[title="Rewind to here"]');
      expect(rewindButton).toBeFalsy();
    });

    it('should not show rewind UI for system messages (only user messages have rewind)', () => {
      const message = createSystemCompactBoundaryMessage();

      const { container } = render(
        <SDKMessageRenderer
          message={message}
          onRewind={onRewind}
          sessionId="test-session"
          rewindingMessageUuid={null}
        />
      );

      const rewindButton = container.querySelector('button[title="Rewind to here"]');
      expect(rewindButton).toBeFalsy();
    });

    it('should render normal message in default mode without rewind props', () => {
      const message = createUserMessage('Plain message');

      const { container } = render(<SDKMessageRenderer message={message} />);

      expect(container.querySelector('[data-testid="user-message"]')).toBeTruthy();
      expect(container.querySelector('input[type="checkbox"]')).toBeFalsy();
    });
  });
});
