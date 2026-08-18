// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { SDKAssistantMessage } from '../SDKAssistantMessage';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { UUID } from 'crypto';
import type { PendingUserQuestion, ResolvedQuestion } from '@hyperneo/shared';

vi.mock('../../../lib/utils.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../lib/utils.ts')>();
  return {
    ...original,
    copyToClipboard: vi.fn(),
  };
});

vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { copyToClipboard } from '../../../lib/utils.ts';
import { toast } from '../../../lib/toast.ts';

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

const createUUID = (): UUID => crypto.randomUUID() as UUID;

function createTextOnlyMessage(text: string): Extract<SDKMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as Extract<SDKMessage, { type: 'assistant' }>;
}

function createToolUseMessage(): Extract<SDKMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_test123',
          name: 'Read',
          input: { file_path: '/test/file.txt' },
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
  } as unknown as Extract<SDKMessage, { type: 'assistant' }>;
}

function createThinkingMessage(): Extract<SDKMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me think about this carefully...' },
        { type: 'text', text: 'Here is my response.' },
      ],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as Extract<SDKMessage, { type: 'assistant' }>;
}

function createMixedContentMessage(): Extract<SDKMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will read the file.' },
        {
          type: 'tool_use',
          id: 'toolu_read123',
          name: 'Read',
          input: { file_path: '/test/file.txt' },
        },
        { type: 'text', text: 'The file has been read.' },
      ],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as Extract<SDKMessage, { type: 'assistant' }>;
}

function createTaskToolMessage(): Extract<SDKMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_task123',
          name: 'Task',
          input: {
            subagent_type: 'Explore',
            description: 'Find all test files',
            prompt: 'Search for test files',
          },
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
  } as unknown as Extract<SDKMessage, { type: 'assistant' }>;
}

function createAgentToolMessage(): Extract<SDKMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_agent123',
          name: 'Agent',
          input: {
            subagent_type: 'Plan',
            description: 'Plan the implementation',
            prompt: 'Create a plan for this feature',
          },
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
  } as unknown as Extract<SDKMessage, { type: 'assistant' }>;
}

function createErrorMessage(): Extract<SDKMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'An error occurred' }],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: null,
    error: 'invalid_request',
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as Extract<SDKMessage, { type: 'assistant' }>;
}

describe('SDKAssistantMessage', () => {
  describe('Basic Rendering', () => {
    it('should render with data-testid attribute', () => {
      const message = createTextOnlyMessage('Hello world');
      const { container } = render(<SDKAssistantMessage message={message} />);

      expect(container.querySelector('[data-testid="assistant-message"]')).toBeTruthy();
    });

    it('should include message role in data attribute', () => {
      const message = createTextOnlyMessage('Hello world');
      const { container } = render(<SDKAssistantMessage message={message} />);

      const element = container.querySelector('[data-message-role]');
      expect(element?.getAttribute('data-message-role')).toBe('assistant');
    });
  });

  describe('Text Content', () => {
    it('should render text content', async () => {
      const message = createTextOnlyMessage('Hello world');
      const { container } = render(<SDKAssistantMessage message={message} />);

      await waitFor(() => {
        expect(container.textContent).toContain('Hello world');
      });
    });

    it('should render multiple text blocks', async () => {
      const message = createMixedContentMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      await waitFor(() => {
        expect(container.textContent).toContain('I will read the file');
        expect(container.textContent).toContain('The file has been read');
      });
    });

    it('should show timestamp', () => {
      const message = createTextOnlyMessage('Hello');
      const messageWithTimestamp = { ...message, timestamp: Date.now() };
      const { container } = render(
        <SDKAssistantMessage message={messageWithTimestamp as typeof message} />
      );

      const timeRegex = /\d{1,2}:\d{2}/;
      expect(container.textContent).toMatch(timeRegex);
    });
  });

  describe('Tool Use Blocks', () => {
    it('should render tool use blocks', () => {
      const message = createToolUseMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      expect(container.textContent).toContain('Read');
    });

    it('should display tool result when available', () => {
      const message = createToolUseMessage();
      const toolResultsMap = new Map([['toolu_test123', { content: 'File content here' }]]);

      const { container } = render(
        <SDKAssistantMessage message={message} toolResultsMap={toolResultsMap} />
      );

      expect(container.textContent).toContain('Read');
    });

    it('should render Task tool as SubagentBlock', () => {
      const message = createTaskToolMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      expect(container.textContent).toContain('Explore');
    });

    it('should render Agent tool as SubagentBlock (SDK 0.2.76+ renamed Task to Agent)', () => {
      const message = createAgentToolMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      expect(container.textContent).toContain('Plan');
      expect(container.textContent).toContain('Plan the implementation');
    });
  });

  describe('Thinking Blocks', () => {
    it('should render thinking blocks', () => {
      const message = createThinkingMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
      expect(container.textContent).toContain('Thinking');
    });

    it('should render thinking content', () => {
      const message = createThinkingMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      expect(container.textContent).toContain('Let me think about this carefully');
    });

    it('should NOT render a thinking card when thinking payload is empty (Opus 4.7 case)', async () => {
      const message = {
        type: 'assistant',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'sig_abc123' },
            { type: 'text', text: 'Here is my response.' },
          ],
          model: 'claude-opus-4-7',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        parent_tool_use_id: null,
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as Extract<SDKMessage, { type: 'assistant' }>;

      const { container } = render(<SDKAssistantMessage message={message} />);

      expect(container.querySelector('[data-testid="thinking-block"]')).toBeNull();
      expect(container.textContent).not.toContain('0 characters');
      await waitFor(() => {
        expect(container.textContent).toContain('Here is my response');
      });
    });

    it('should NOT render a thinking card for whitespace-only thinking payload', async () => {
      const message = {
        type: 'assistant',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '   \n\t  ' },
            { type: 'text', text: 'Only whitespace thinking.' },
          ],
          model: 'claude-opus-4-7',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        parent_tool_use_id: null,
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as Extract<SDKMessage, { type: 'assistant' }>;

      const { container } = render(<SDKAssistantMessage message={message} />);

      expect(container.querySelector('[data-testid="thinking-block"]')).toBeNull();
      await waitFor(() => {
        expect(container.textContent).toContain('Only whitespace thinking');
      });
    });

    it('should still render valid thinking on same-model messages (no regression)', () => {
      const message = {
        type: 'assistant',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Real reasoning here.', signature: 'sig_xyz' },
            { type: 'text', text: 'And the answer.' },
          ],
          model: 'claude-opus-4-7',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        parent_tool_use_id: null,
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as Extract<SDKMessage, { type: 'assistant' }>;

      const { container } = render(<SDKAssistantMessage message={message} />);

      expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
      expect(container.textContent).toContain('Real reasoning here');
    });

    it('should filter empty thinking blocks alongside non-empty ones', () => {
      const message = {
        type: 'assistant',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'sig_empty' },
            { type: 'thinking', thinking: 'Actual reasoning.' },
            { type: 'text', text: 'Reply.' },
          ],
          model: 'claude-opus-4-7',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        parent_tool_use_id: null,
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as Extract<SDKMessage, { type: 'assistant' }>;

      const { container } = render(<SDKAssistantMessage message={message} />);

      const cards = container.querySelectorAll('[data-testid="thinking-block"]');
      expect(cards.length).toBe(1);
      expect(container.textContent).toContain('Actual reasoning');
    });

    it('should NOT render estimate-only card when no thinking blocks exist', () => {
      const message: Extract<SDKMessage, { type: 'assistant' }> = {
        type: 'assistant',
        message: {
          id: 'msg_estimate_only',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Response without thinking.' }],
          model: 'claude-3-5-sonnet-20241022',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        parent_tool_use_id: null,
        uuid: 'estimate-only-uuid',
        session_id: 'test-session',
        estimated_thinking_tokens: 5000,
      } as unknown as Extract<SDKMessage, { type: 'assistant' }>;

      const { container } = render(<SDKAssistantMessage message={message} />);

      expect(container.querySelector('[data-testid="thinking-block"]')).toBeNull();
    });
  });

  describe('Error State', () => {
    it('should apply error styling when message has error', () => {
      const message = createErrorMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      expect(container.querySelector('.bg-red-50, .dark\\:bg-red-900\\/20')).toBeTruthy();
    });

    it('should show API Error label', () => {
      const message = createErrorMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      expect(container.textContent).toContain('API Error');
    });
  });

  describe('Parent Tool Use (Sub-agent)', () => {
    it('should show parent tool use indicator for sub-agent messages', () => {
      const message = createTextOnlyMessage('Sub-agent response');
      const subAgentMessage = {
        ...message,
        parent_tool_use_id: 'toolu_parent123',
      } as typeof message;

      const { container } = render(<SDKAssistantMessage message={subAgentMessage} />);

      expect(container.textContent).toContain('Sub-agent response');
    });
  });

  describe('Copy Functionality', () => {
    it('should have copy button', () => {
      const message = createTextOnlyMessage('Hello world');
      const { container } = render(<SDKAssistantMessage message={message} />);

      const copyButton = container.querySelector('button[title="Copy message"]');
      expect(copyButton).toBeTruthy();
    });

    it('should show inline green check when copy succeeds', async () => {
      vi.mocked(copyToClipboard).mockResolvedValue(true);

      const message = createTextOnlyMessage('Hello world');
      const { container } = render(<SDKAssistantMessage message={message} />);

      const copyButton = container.querySelector('button[title="Copy message"]');
      fireEvent.click(copyButton!);

      await vi.waitFor(() => {
        expect(copyToClipboard).toHaveBeenCalledWith('Hello world');
        const copiedButton = container.querySelector('button[title="Copied!"]');
        expect(copiedButton).toBeTruthy();
        expect(copiedButton?.className).toContain('text-green-400');
      });
    });

    it('should not show green check and show error toast when copy fails', async () => {
      vi.mocked(copyToClipboard).mockResolvedValue(false);

      const message = createTextOnlyMessage('Hello world');
      const { container } = render(<SDKAssistantMessage message={message} />);

      const copyButton = container.querySelector('button[title="Copy message"]');
      fireEvent.click(copyButton!);

      await vi.waitFor(() => {
        expect(copyToClipboard).toHaveBeenCalledWith('Hello world');
        expect(container.querySelector('button[title="Copy message"]')).toBeTruthy();
        expect(toast.error).toHaveBeenCalledWith('Failed to copy message');
      });
    });

    it('should only copy text content from mixed content message', async () => {
      vi.mocked(copyToClipboard).mockResolvedValue(true);

      const message = createMixedContentMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      const copyButton = container.querySelector('button[title="Copy message"]');
      fireEvent.click(copyButton!);

      await vi.waitFor(() => {
        expect(copyToClipboard).toHaveBeenCalledWith(
          'I will read the file.\nThe file has been read.'
        );
        expect(container.querySelector('button[title="Copied!"]')).toBeTruthy();
      });
    });

    describe('auto-revert behavior', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('should revert to copy icon after 1500ms', async () => {
        vi.mocked(copyToClipboard).mockResolvedValue(true);

        const message = createTextOnlyMessage('Hello world');
        const { container } = render(<SDKAssistantMessage message={message} />);

        const copyButton = container.querySelector('button[title="Copy message"]');
        fireEvent.click(copyButton!);

        await vi.waitFor(() => {
          expect(container.querySelector('button[title="Copied!"]')).toBeTruthy();
        });

        vi.advanceTimersByTime(1500);

        await vi.waitFor(() => {
          expect(container.querySelector('button[title="Copy message"]')).toBeTruthy();
        });
      });
    });
  });

  describe('Question Handling (AskUserQuestion)', () => {
    it('should render AskUserQuestion tool with QuestionPrompt', () => {
      const message = {
        type: 'assistant',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_question123',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Which option?',
                    header: 'Select one',
                    options: [
                      { label: 'A', description: 'Option A' },
                      { label: 'B', description: 'Option B' },
                    ],
                    multiSelect: false,
                  },
                ],
              },
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
      } as unknown as Extract<SDKMessage, { type: 'assistant' }>;

      const { container } = render(
        <SDKAssistantMessage message={message} sessionId="test-session" />
      );

      expect(container.textContent).toContain('AskUserQuestion');
    });

    it('should render fallback ToolResultCard when AskUserQuestion has invalid input (no questions array)', () => {
      const message = {
        type: 'assistant',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_invalid123',
              name: 'AskUserQuestion',
              input: {
                invalidField: 'some value',
              },
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
      } as unknown as Extract<SDKMessage, { type: 'assistant' }>;

      const { container } = render(
        <SDKAssistantMessage
          message={message}
          sessionId="test-session"
          resolvedQuestions={new Map()}
        />
      );

      expect(container.textContent).toContain('AskUserQuestion');
      expect(container.textContent).not.toContain('Claude needs your input');
      expect(container.textContent).not.toContain('Question skipped');
    });

    it('should render fallback ToolResultCard when AskUserQuestion has non-array questions', () => {
      const message = {
        type: 'assistant',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_nonarray123',
              name: 'AskUserQuestion',
              input: {
                questions: 'not an array',
              },
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
      } as unknown as Extract<SDKMessage, { type: 'assistant' }>;

      const { container } = render(
        <SDKAssistantMessage
          message={message}
          sessionId="test-session"
          resolvedQuestions={new Map()}
        />
      );

      expect(container.textContent).toContain('AskUserQuestion');
      expect(container.textContent).not.toContain('Claude needs your input');
      expect(container.textContent).not.toContain('Question skipped');
    });
  });

  describe('Question Form Persistence', () => {
    let onQuestionResolved: ReturnType<typeof vi.fn>;
    let mockResolvedQuestions: Map<string, ResolvedQuestion>;
    let mockPendingQuestion: PendingUserQuestion;

    beforeEach(() => {
      onQuestionResolved = vi.fn();

      mockResolvedQuestions = new Map();

      mockPendingQuestion = {
        toolUseId: 'toolu_pending123',
        questions: [
          {
            question: 'What should we do?',
            header: 'Action',
            options: [
              { label: 'Create', description: 'Create new file' },
              { label: 'Delete', description: 'Delete existing file' },
            ],
            multiSelect: false,
          },
        ],
        askedAt: Date.now(),
      };
    });

    function createAskUserQuestionMessage(
      toolId: string = 'toolu_question123'
    ): Extract<SDKMessage, { type: 'assistant' }> {
      return {
        type: 'assistant',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: toolId,
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'What should we do?',
                    header: 'Action',
                    options: [
                      { label: 'Create', description: 'Create new file' },
                      { label: 'Delete', description: 'Delete existing file' },
                    ],
                    multiSelect: false,
                  },
                ],
              },
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
      } as unknown as Extract<SDKMessage, { type: 'assistant' }>;
    }

    describe('Form Always Visible', () => {
      it('should render QuestionPrompt for resolved questions', () => {
        const message = createAskUserQuestionMessage('toolu_resolved123');
        const resolved: ResolvedQuestion = {
          question: mockPendingQuestion,
          state: 'submitted',
          responses: [
            {
              questionIndex: 0,
              selectedLabels: ['Create'],
              customText: undefined,
            },
          ],
          resolvedAt: Date.now(),
        };
        mockResolvedQuestions.set('toolu_resolved123', resolved);

        const { container } = render(
          <SDKAssistantMessage
            message={message}
            sessionId="test-session"
            resolvedQuestions={mockResolvedQuestions}
            onQuestionResolved={onQuestionResolved}
          />
        );

        expect(container.textContent).toContain('Response submitted');
      });

      it('should render QuestionPrompt for pending questions', () => {
        const message = createAskUserQuestionMessage('toolu_pending123');

        const { container } = render(
          <SDKAssistantMessage
            message={message}
            sessionId="test-session"
            pendingQuestion={mockPendingQuestion}
            onQuestionResolved={onQuestionResolved}
          />
        );

        expect(container.textContent).toContain('What should we do?');
        expect(container.textContent).toContain('Claude needs your input');
      });

      it('should render QuestionPrompt from tool input when neither resolved nor pending', () => {
        const message = createAskUserQuestionMessage('toolu_old123');

        const { container } = render(
          <SDKAssistantMessage
            message={message}
            sessionId="test-session"
            resolvedQuestions={new Map()}
            onQuestionResolved={onQuestionResolved}
          />
        );

        expect(container.textContent).toContain('Question skipped');
      });

      it('should NEVER hide the QuestionPrompt form', () => {
        const message = createAskUserQuestionMessage('toolu_alwaysvisible');

        const { container } = render(
          <SDKAssistantMessage
            message={message}
            sessionId="test-session"
            resolvedQuestions={new Map()}
            onQuestionResolved={onQuestionResolved}
          />
        );

        expect(container.textContent).toContain('Question skipped');
      });
    });

    describe('Resolved State Display', () => {
      it('should show submitted state with responses', () => {
        const message = createAskUserQuestionMessage('toolu_submitted123');
        const resolved: ResolvedQuestion = {
          question: mockPendingQuestion,
          state: 'submitted',
          responses: [
            {
              questionIndex: 0,
              selectedLabels: ['Create'],
              customText: undefined,
            },
          ],
          resolvedAt: Date.now(),
        };
        mockResolvedQuestions.set('toolu_submitted123', resolved);

        const { container } = render(
          <SDKAssistantMessage
            message={message}
            sessionId="test-session"
            resolvedQuestions={mockResolvedQuestions}
          />
        );

        expect(container.textContent).toContain('Response submitted');
      });

      it('should show cancelled state', () => {
        const message = createAskUserQuestionMessage('toolu_cancelled123');
        const resolved: ResolvedQuestion = {
          question: mockPendingQuestion,
          state: 'cancelled',
          responses: [],
          resolvedAt: Date.now(),
        };
        mockResolvedQuestions.set('toolu_cancelled123', resolved);

        const { container } = render(
          <SDKAssistantMessage
            message={message}
            sessionId="test-session"
            resolvedQuestions={mockResolvedQuestions}
          />
        );

        expect(container.textContent).toContain('Question skipped');
      });

      it('should disable form inputs in resolved state', () => {
        const message = createAskUserQuestionMessage('toolu_disabled123');
        const resolved: ResolvedQuestion = {
          question: mockPendingQuestion,
          state: 'submitted',
          responses: [
            {
              questionIndex: 0,
              selectedLabels: ['Create'],
              customText: undefined,
            },
          ],
          resolvedAt: Date.now(),
        };
        mockResolvedQuestions.set('toolu_disabled123', resolved);

        const { container } = render(
          <SDKAssistantMessage
            message={message}
            sessionId="test-session"
            resolvedQuestions={mockResolvedQuestions}
          />
        );

        expect(container.textContent).not.toContain('Submit Response');
      });
    });

    describe('Pending State Display', () => {
      it('should show active form for pending questions', () => {
        const message = createAskUserQuestionMessage('toolu_pending123');

        const { container } = render(
          <SDKAssistantMessage
            message={message}
            sessionId="test-session"
            pendingQuestion={mockPendingQuestion}
            onQuestionResolved={onQuestionResolved}
          />
        );

        expect(container.textContent).toContain('Claude needs your input');
        expect(container.textContent).toContain('Submit Response');
        expect(container.textContent).toContain('Skip Question');
      });

      it('should call onQuestionResolved when question is submitted', () => {
        const message = createAskUserQuestionMessage('toolu_submit123');

        const { container } = render(
          <SDKAssistantMessage
            message={message}
            sessionId="test-session"
            pendingQuestion={mockPendingQuestion}
            onQuestionResolved={onQuestionResolved}
          />
        );

        const submitButton = Array.from(container.querySelectorAll('button')).find(
          (b) => b.textContent === 'Submit Response'
        );

        if (submitButton) {
          const options = container.querySelectorAll('button');
          const createOption = Array.from(options).find((o) => o.textContent?.includes('Create'));
          createOption?.click();

          submitButton.click();
        }
      });
    });

    describe('Tool Input Extraction', () => {
      it('should extract question data from tool input for old questions', () => {
        const toolId = 'toolu_extract123';
        const message = createAskUserQuestionMessage(toolId);

        const { container } = render(
          <SDKAssistantMessage
            message={message}
            sessionId="test-session"
            resolvedQuestions={new Map()}
            onQuestionResolved={onQuestionResolved}
          />
        );

        expect(container.textContent).toContain('Question skipped');
      });

      it('should handle multi-select questions from tool input', () => {
        const message = {
          type: 'assistant',
          message: {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_multiselect123',
                name: 'AskUserQuestion',
                input: {
                  questions: [
                    {
                      question: 'Select options',
                      header: 'Multiple',
                      options: [
                        { label: 'A', description: 'Option A' },
                        { label: 'B', description: 'Option B' },
                        { label: 'C', description: 'Option C' },
                      ],
                      multiSelect: true,
                    },
                  ],
                },
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
        } as unknown as Extract<SDKMessage, { type: 'assistant' }>;

        const { container } = render(
          <SDKAssistantMessage
            message={message}
            sessionId="test-session"
            resolvedQuestions={new Map()}
            onQuestionResolved={onQuestionResolved}
          />
        );

        expect(container.textContent).toContain('Question skipped');
      });

      it('should handle multiple questions from tool input', () => {
        const message = {
          type: 'assistant',
          message: {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_multiple123',
                name: 'AskUserQuestion',
                input: {
                  questions: [
                    {
                      question: 'First question?',
                      header: 'Q1',
                      options: [{ label: 'Yes', description: '' }],
                      multiSelect: false,
                    },
                    {
                      question: 'Second question?',
                      header: 'Q2',
                      options: [{ label: 'No', description: '' }],
                      multiSelect: false,
                    },
                  ],
                },
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
        } as unknown as Extract<SDKMessage, { type: 'assistant' }>;

        const { container } = render(
          <SDKAssistantMessage
            message={message}
            sessionId="test-session"
            resolvedQuestions={new Map()}
            onQuestionResolved={onQuestionResolved}
          />
        );

        expect(container.textContent).toContain('Question skipped');
      });
    });
  });
});
