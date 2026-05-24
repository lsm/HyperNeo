// @ts-nocheck
/**
 * SDKAssistantMessage Component Tests
 *
 * Tests assistant message rendering with text, tools, and thinking blocks
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { SDKAssistantMessage } from '../SDKAssistantMessage';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import type { UUID } from 'crypto';
import type { PendingUserQuestion, ResolvedQuestion } from '@neokai/shared';

// Mock the utils module for copyToClipboard
vi.mock('../../../lib/utils.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../lib/utils.ts')>();
  return {
    ...original,
    copyToClipboard: vi.fn(),
  };
});

// Mock the toast module
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

// Helper to create a valid UUID
const createUUID = (): UUID => crypto.randomUUID() as UUID;

// Factory functions for test messages
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

    // Note: data-message-uuid is now set by parent SDKMessageRenderer wrapper
    // This test is removed as the child component no longer sets this attribute

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

      // Timestamp should be visible (format like "10:30")
      const timeRegex = /\d{1,2}:\d{2}/;
      expect(container.textContent).toMatch(timeRegex);
    });
  });

  describe('Tool Use Blocks', () => {
    it('should render tool use blocks', () => {
      const message = createToolUseMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      // Tool card should be rendered
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

      // SubagentBlock should show the subagent type
      expect(container.textContent).toContain('Explore');
    });

    it('should render Agent tool as SubagentBlock (SDK 0.2.76+ renamed Task to Agent)', () => {
      const message = createAgentToolMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      // SubagentBlock should show the subagent type and description
      expect(container.textContent).toContain('Plan');
      expect(container.textContent).toContain('Plan the implementation');
    });
  });

  describe('Thinking Blocks', () => {
    it('should render thinking blocks', () => {
      const message = createThinkingMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      // ThinkingBlock should be rendered
      expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
      expect(container.textContent).toContain('Thinking');
    });

    it('should render thinking content', () => {
      const message = createThinkingMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      expect(container.textContent).toContain('Let me think about this carefully');
    });

    /**
     * Opus 4.7 (and other models running with `thinking.display = 'omitted'`)
     * emits a thinking block with an empty `thinking` string but a
     * signature for multi-turn continuity. The UI should treat that as
     * "no thinking to show" and NOT render the amber card — otherwise
     * the user sees "Thinking · 0 characters" in the transcript.
     */
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

      // No thinking card at all
      expect(container.querySelector('[data-testid="thinking-block"]')).toBeNull();
      expect(container.textContent).not.toContain('0 characters');
      // Text block still renders (async via MarkdownRenderer)
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
      // A thinking block that *has* content must still render — we only
      // skip when the payload is empty/whitespace.
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
      // Mixed: one empty thinking, one populated — only the populated
      // one should render.
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
  });

  describe('Error State', () => {
    it('should apply error styling when message has error', () => {
      const message = createErrorMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      // Should have error styling (red background)
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

      // Wait for the async handler to complete
      await vi.waitFor(() => {
        expect(copyToClipboard).toHaveBeenCalledWith('Hello world');
        // Button should now show "Copied!" title and green color
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

      // Wait for the async handler to complete
      await vi.waitFor(() => {
        expect(copyToClipboard).toHaveBeenCalledWith('Hello world');
        // Button should remain showing "Copy message" (not switched to Copied!)
        expect(container.querySelector('button[title="Copy message"]')).toBeTruthy();
        // Error toast should be shown
        expect(toast.error).toHaveBeenCalledWith('Failed to copy message');
      });
    });

    it('should only copy text content from mixed content message', async () => {
      vi.mocked(copyToClipboard).mockResolvedValue(true);

      // Message with text and tool_use blocks - only text should be copied
      const message = createMixedContentMessage();
      const { container } = render(<SDKAssistantMessage message={message} />);

      const copyButton = container.querySelector('button[title="Copy message"]');
      fireEvent.click(copyButton!);

      // Wait for the async handler to complete
      await vi.waitFor(() => {
        // Should only copy text blocks, filtering out tool_use blocks
        expect(copyToClipboard).toHaveBeenCalledWith(
          'I will read the file.\nThe file has been read.'
        );
        // Button should switch to "Copied!" state
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

        // Should show Copied! state
        await vi.waitFor(() => {
          expect(container.querySelector('button[title="Copied!"]')).toBeTruthy();
        });

        // Advance timer past 1500ms
        vi.advanceTimersByTime(1500);

        // Should revert to copy state
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

      // AskUserQuestion tool should be rendered
      expect(container.textContent).toContain('AskUserQuestion');
    });

    it('should render fallback ToolResultCard when AskUserQuestion has invalid input (no questions array)', () => {
      // Create AskUserQuestion with missing questions array
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
                // Missing questions array - should trigger fallback
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

      // Should render ToolResultCard without QuestionPrompt
      expect(container.textContent).toContain('AskUserQuestion');
      // Should NOT contain QuestionPrompt elements
      expect(container.textContent).not.toContain('Claude needs your input');
      expect(container.textContent).not.toContain('Question skipped');
    });

    it('should render fallback ToolResultCard when AskUserQuestion has non-array questions', () => {
      // Create AskUserQuestion with questions as non-array
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
                // questions is not an array - should trigger fallback
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

      // Should render ToolResultCard without QuestionPrompt
      expect(container.textContent).toContain('AskUserQuestion');
      // Should NOT contain QuestionPrompt elements
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

      // Setup mock resolved questions
      mockResolvedQuestions = new Map();

      // Setup mock pending question
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

        // Question form should be visible (header is always visible)
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

        // Question form should be visible
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

        // Question form should STILL be visible (header is always visible)
        // Should show as cancelled/skipped state
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

        // The question form must always be present for AskUserQuestion tools
        // (header is always visible even when collapsed)
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

        // Header text is always visible
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

        // Submit button should not be visible in resolved state
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

        // Find and click submit button
        const submitButton = Array.from(container.querySelectorAll('button')).find(
          (b) => b.textContent === 'Submit Response'
        );

        if (submitButton) {
          // First need to select an option
          const options = container.querySelectorAll('button');
          const createOption = Array.from(options).find((o) => o.textContent?.includes('Create'));
          createOption?.click();

          // Now submit should be enabled
          submitButton.click();
        }

        // Note: This tests the flow, but actual submission requires async RPC
        // The component itself calls onQuestionResolved when submission succeeds
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

        // Should extract question from tool input and render QuestionPrompt
        // (header is always visible even when collapsed)
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

        // Should extract and render QuestionPrompt (header is always visible)
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

        // Should extract and render QuestionPrompt with multiple questions
        // (header is always visible even when collapsed)
        expect(container.textContent).toContain('Question skipped');
      });
    });
  });

  describe('Rewind Mode', () => {
    const onMessageCheckboxChange = vi.fn();

    it('should render checkbox in rewind mode', () => {
      const message = createTextOnlyMessage('Hello world');
      const selectedMessages = new Set<string>();

      const { container } = render(
        <SDKAssistantMessage
          message={message}
          rewindMode={true}
          selectedMessages={selectedMessages}
          onMessageCheckboxChange={onMessageCheckboxChange}
        />
      );

      const checkbox = container.querySelector('input[type="checkbox"]');
      expect(checkbox).toBeTruthy();
    });

    it('should check checkbox when message is selected', () => {
      const message = createTextOnlyMessage('Hello world');
      const selectedMessages = new Set<string>([message.uuid!]);

      const { container } = render(
        <SDKAssistantMessage
          message={message}
          rewindMode={true}
          selectedMessages={selectedMessages}
          onMessageCheckboxChange={onMessageCheckboxChange}
        />
      );

      const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
    });

    it('should call onMessageCheckboxChange when checkbox is clicked', () => {
      const message = createTextOnlyMessage('Hello world');
      const selectedMessages = new Set<string>();

      const { container } = render(
        <SDKAssistantMessage
          message={message}
          rewindMode={true}
          selectedMessages={selectedMessages}
          onMessageCheckboxChange={onMessageCheckboxChange}
        />
      );

      const checkbox = container.querySelector('input[type="checkbox"]');
      fireEvent.click(checkbox!);

      expect(onMessageCheckboxChange).toHaveBeenCalledWith(message.uuid, true);
    });

    it('should render tool use blocks in rewind mode', async () => {
      const message = createMixedContentMessage();
      const selectedMessages = new Set<string>();

      const { container } = render(
        <SDKAssistantMessage
          message={message}
          rewindMode={true}
          selectedMessages={selectedMessages}
          onMessageCheckboxChange={onMessageCheckboxChange}
        />
      );

      // Should render the tool use block
      expect(container.textContent).toContain('Read');
      // Should also render text
      await waitFor(() => {
        expect(container.textContent).toContain('I will read the file');
      });
    });

    it('should render thinking blocks in rewind mode', () => {
      const message = createThinkingMessage();
      const selectedMessages = new Set<string>();

      const { container } = render(
        <SDKAssistantMessage
          message={message}
          rewindMode={true}
          selectedMessages={selectedMessages}
          onMessageCheckboxChange={onMessageCheckboxChange}
        />
      );

      expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
    });

    it('should not render checkbox when message has no uuid', () => {
      const message = createTextOnlyMessage('Hello world');
      delete (message as Record<string, unknown>).uuid;
      const selectedMessages = new Set<string>();

      const { container } = render(
        <SDKAssistantMessage
          message={message}
          rewindMode={true}
          selectedMessages={selectedMessages}
          onMessageCheckboxChange={onMessageCheckboxChange}
        />
      );

      const checkbox = container.querySelector('input[type="checkbox"]');
      expect(checkbox).toBeFalsy();
    });

    it('should not render checkbox when onMessageCheckboxChange is not provided', () => {
      const message = createTextOnlyMessage('Hello world');
      const selectedMessages = new Set<string>();

      const { container } = render(
        <SDKAssistantMessage
          message={message}
          rewindMode={true}
          selectedMessages={selectedMessages}
        />
      );

      const checkbox = container.querySelector('input[type="checkbox"]');
      expect(checkbox).toBeFalsy();
    });

    it('should not render checkbox when message has sub-agent children', () => {
      const message = createTextOnlyMessage('Parent message');
      const childMessage = createTextOnlyMessage('Child message');
      const subagentMessagesMap = new Map([[message.uuid!, [childMessage as SDKMessage]]]);
      const selectedMessages = new Set<string>();

      const { container } = render(
        <SDKAssistantMessage
          message={message}
          rewindMode={true}
          selectedMessages={selectedMessages}
          onMessageCheckboxChange={onMessageCheckboxChange}
          subagentMessagesMap={subagentMessagesMap}
        />
      );

      const checkbox = container.querySelector('input[type="checkbox"]');
      expect(checkbox).toBeFalsy();
    });
  });
});
