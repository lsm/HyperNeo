// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { SDKUserMessage } from '../SDKUserMessage';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { UUID } from 'crypto';

vi.mock('../../../hooks/useMessageHub', () => ({
  useMessageHub: () => ({
    isConnected: false,
    state: 'disconnected',
    getHub: () => null,
    request: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    joinRoom: vi.fn(),
    leaveRoom: vi.fn(),
    call: vi.fn(),
    callIfConnected: vi.fn().mockResolvedValue(null),
    subscribe: vi.fn(() => () => {}),
    waitForConnection: vi.fn(),
    onConnected: vi.fn(() => () => {}),
  }),
}));

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

vi.mock('../../../lib/api-helpers.ts', () => ({
  retryMessageDelivery: vi.fn().mockResolvedValue({ retried: true }),
}));

import { copyToClipboard } from '../../../lib/utils.ts';
import { toast } from '../../../lib/toast.ts';
import { retryMessageDelivery } from '../../../lib/api-helpers.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

const createUUID = (): UUID => crypto.randomUUID() as UUID;

function createTextMessage(text: string): Extract<SDKMessage, { type: 'user' }> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: text,
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

function createArrayContentMessage(
  blocks: Array<Record<string, unknown>>
): Extract<SDKMessage, { type: 'user' }> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: blocks,
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as Extract<SDKMessage, { type: 'user' }>;
}

function createImageMessage(): Extract<SDKMessage, { type: 'user' }> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'Here is an image:' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          },
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as Extract<SDKMessage, { type: 'user' }>;
}

function createToolResultMessage(): Extract<SDKMessage, { type: 'user' }> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_test123',
          content: 'Tool execution result',
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as Extract<SDKMessage, { type: 'user' }>;
}

function createSyntheticMessage(): Extract<SDKMessage, { type: 'user' }> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: 'Interrupt: User cancelled operation',
    },
    parent_tool_use_id: null,
    isSynthetic: true,
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

function createReplayMessage(content: string): Extract<SDKMessage, { type: 'user' }> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: content,
    },
    parent_tool_use_id: null,
    uuid: createUUID(),
    session_id: 'test-session',
    isReplay: true,
  } as unknown as Extract<SDKMessage, { type: 'user' }>;
}

function createSessionInfo(): Extract<SDKMessage, { type: 'system'; subtype: 'init' }> {
  return {
    type: 'system',
    subtype: 'init',
    agents: [],
    apiKeySource: 'user',
    betas: [],
    claude_code_version: '1.0.0',
    cwd: '/test/path',
    tools: ['Read', 'Write', 'Bash'],
    mcp_servers: [{ name: 'test-server', status: 'connected' }],
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

describe('SDKUserMessage', () => {
  describe('Basic Rendering', () => {
    it('should render with data-testid attribute', () => {
      const message = createTextMessage('Hello world');
      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.querySelector('[data-testid="user-message"]')).toBeTruthy();
    });

    it('should include message role in data attribute', () => {
      const message = createTextMessage('Hello world');
      const { container } = render(<SDKUserMessage message={message} />);

      const element = container.querySelector('[data-message-role]');
      expect(element?.getAttribute('data-message-role')).toBe('user');
    });
  });

  describe('Text Content', () => {
    it('should render string content', () => {
      const message = createTextMessage('Hello world');
      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.textContent).toContain('Hello world');
    });

    it('should render array content with text blocks', () => {
      const message = createArrayContentMessage([
        { type: 'text', text: 'First block' },
        { type: 'text', text: 'Second block' },
      ]);
      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.textContent).toContain('First block');
    });

    it('should preserve whitespace', () => {
      const message = createTextMessage('Line 1\nLine 2\nLine 3');
      const { container } = render(<SDKUserMessage message={message} />);

      const textDiv = container.querySelector('.whitespace-pre-wrap');
      expect(textDiv).toBeTruthy();
    });
  });

  describe('Image Content', () => {
    it('should render attached images', () => {
      const message = createImageMessage();
      const { container } = render(<SDKUserMessage message={message} />);

      const img = container.querySelector('img');
      expect(img).toBeTruthy();
      expect(img?.getAttribute('src')).toContain('data:image/png;base64');
    });

    it('should render text alongside images', () => {
      const message = createImageMessage();
      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.textContent).toContain('Here is an image');
      expect(container.querySelector('img')).toBeTruthy();
    });
  });

  describe('Tool Result Messages', () => {
    it('should not render tool result messages', () => {
      const message = createToolResultMessage();
      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.innerHTML).toBe('');
    });
  });

  describe('Synthetic Messages', () => {
    it('should render synthetic messages with special styling', () => {
      const message = createSyntheticMessage();
      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.querySelector('[data-testid="synthetic-card"]')).toBeTruthy();
    });

    it('should show synthetic label in the card header', () => {
      const message = createSyntheticMessage();
      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.textContent).toContain('Synthetic');
    });

    it('should handle synthetic message with non-object content blocks', () => {
      const message = {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Valid text block' }, 'plain string element', 123, true],
        },
        parent_tool_use_id: null,
        isSynthetic: true,
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as Extract<SDKMessage, { type: 'user' }>;

      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.querySelector('[data-testid="synthetic-card"]')).toBeTruthy();
    });

    it('should return null for synthetic message with invalid content type', () => {
      const message = {
        type: 'user',
        message: {
          role: 'user',
          content: 12345,
        },
        parent_tool_use_id: null,
        isSynthetic: true,
        uuid: createUUID(),
        session_id: 'test-session',
      } as unknown as Extract<SDKMessage, { type: 'user' }>;

      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.querySelector('[data-testid="user-message"]')).toBeTruthy();
    });
  });

  describe('Replay Messages (Slash Commands)', () => {
    it('should render command output with SlashCommandOutput', async () => {
      const message = createReplayMessage(
        '<local-command-stdout>Command executed successfully</local-command-stdout>'
      );
      const { container } = render(<SDKUserMessage message={message} isReplay={true} />);

      await waitFor(() => {
        expect(container.textContent).toContain('Command executed successfully');
      });
    });

    it('should hide "Compacted" output (shown in CompactBoundaryMessage)', () => {
      const message = createReplayMessage('<local-command-stdout>Compacted</local-command-stdout>');
      const { container } = render(<SDKUserMessage message={message} isReplay={true} />);

      expect(container.innerHTML).toBe('');
    });
  });

  describe('Error Output', () => {
    it('should render error output with ErrorOutput component', () => {
      const message = createTextMessage(
        '<local-command-stderr>Error: Something went wrong</local-command-stderr>'
      );
      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.textContent).toContain('Error');
    });
  });

  describe('Session Info', () => {
    it('should show session info icon when sessionInfo is provided', () => {
      const message = createTextMessage('Hello');
      const sessionInfo = createSessionInfo();

      const { container } = render(<SDKUserMessage message={message} sessionInfo={sessionInfo} />);

      const infoButton = container.querySelector('button[title="Session info"]');
      expect(infoButton).toBeTruthy();
    });

    it('should not show session info icon when sessionInfo is not provided', () => {
      const message = createTextMessage('Hello');
      const { container } = render(<SDKUserMessage message={message} />);

      const infoButton = container.querySelector('button[title="Session info"]');
      expect(infoButton).toBeFalsy();
    });
  });

  describe('Parent Tool Use (Sub-agent)', () => {
    it('should show parent tool use indicator for sub-agent messages', () => {
      const message = {
        ...createTextMessage('Sub-agent user message'),
        parent_tool_use_id: 'toolu_parent123',
      };

      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.textContent).toContain('Sub-agent message');
      expect(container.textContent).toContain('toolu_pa');
    });
  });

  describe('Timestamp', () => {
    it('should show timestamp when available', () => {
      const message = {
        ...createTextMessage('Hello'),
        timestamp: Date.now(),
      };

      const { container } = render(<SDKUserMessage message={message} />);

      const timeRegex = /\d{1,2}:\d{2}/;
      expect(container.textContent).toMatch(timeRegex);
    });
  });

  describe('Copy Functionality', () => {
    it('should have copy button', () => {
      const message = createTextMessage('Hello world');
      const { container } = render(<SDKUserMessage message={message} />);

      const copyButton = container.querySelector('button[title="Copy message"]');
      expect(copyButton).toBeTruthy();
    });

    it('should show inline green check when copy succeeds', async () => {
      vi.mocked(copyToClipboard).mockResolvedValue(true);

      const message = createTextMessage('Hello world');
      const { container } = render(<SDKUserMessage message={message} />);

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

      const message = createTextMessage('Hello world');
      const { container } = render(<SDKUserMessage message={message} />);

      const copyButton = container.querySelector('button[title="Copy message"]');
      fireEvent.click(copyButton!);

      await vi.waitFor(() => {
        expect(copyToClipboard).toHaveBeenCalledWith('Hello world');
        expect(container.querySelector('button[title="Copy message"]')).toBeTruthy();
        expect(toast.error).toHaveBeenCalledWith('Failed to copy message');
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

        const message = createTextMessage('Hello world');
        const { container } = render(<SDKUserMessage message={message} />);

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

  describe('Delivery Status', () => {
    it('should show "not delivered" badge when deliveryStatus is failed', () => {
      const message = {
        ...createTextMessage('Hello world'),
        deliveryStatus: 'failed' as const,
      };

      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.textContent).toContain('not delivered');
    });

    it('should show "queued" badge when deliveryStatus is queued', () => {
      const message = {
        ...createTextMessage('Hello world'),
        deliveryStatus: 'queued' as const,
      };

      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.textContent).toContain('queued');
    });

    it('should show "sending" badge when deliveryStatus is processing', () => {
      const message = {
        ...createTextMessage('Hello world'),
        deliveryStatus: 'processing' as const,
      };

      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.textContent).toContain('sending');
    });

    it('should show "retrying" badge with stalled-delivery copy when deliveryStatus is retrying', async () => {
      const message = {
        ...createTextMessage('Hello world'),
        deliveryStatus: 'retrying' as const,
      };

      const { container } = render(<SDKUserMessage message={message} />);

      const badge = container.querySelector('[data-testid="user-delivery-state"]');
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toContain('retrying');

      fireEvent.mouseEnter(badge!.parentElement!);
      await waitFor(() => {
        expect(container.textContent).toContain('Delivery stalled — retrying');
      });
    });

    it('should NOT show a badge when deliveryStatus is delivered (avoid noise)', () => {
      const message = {
        ...createTextMessage('Hello world'),
        deliveryStatus: 'delivered' as const,
      };

      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.textContent).not.toContain('delivered');
      expect(container.textContent).not.toContain('not delivered');
    });

    it('should not show a badge when deliveryStatus is absent', () => {
      const message = createTextMessage('Hello world');

      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.textContent).not.toContain('not delivered');
      expect(container.textContent).not.toContain('queued');
    });

    it('shows a Retry button for a failed message and re-enqueues on click', async () => {
      vi.mocked(retryMessageDelivery).mockResolvedValue({ retried: true });
      const message = {
        ...createTextMessage('Hello world'),
        id: 'db-1',
        deliveryStatus: 'failed' as const,
      };

      const { container } = render(<SDKUserMessage message={message} sessionId="sess-1" />);

      const retryButton = container.querySelector('[data-testid="user-delivery-retry-button"]');
      expect(retryButton).toBeTruthy();
      fireEvent.click(retryButton!);

      await waitFor(() => {
        expect(retryMessageDelivery).toHaveBeenCalledWith('sess-1', 'db-1');
      });
    });

    it('shows a retry countdown + retry N/Max for a retrying message', () => {
      const message = {
        ...createTextMessage('Hello world'),
        deliveryStatus: 'retrying' as const,
        deliveryRetry: { count: 2, runAt: Date.now() + 5000, maxRetries: 8 },
      };

      const { container } = render(<SDKUserMessage message={message} />);

      const countdown = container.querySelector('[data-testid="user-delivery-retry-countdown"]');
      expect(countdown).toBeTruthy();
      expect(countdown?.textContent).toContain('retrying in');
      expect(countdown?.textContent).toContain('retry 2/8');
    });
  });

  describe('Rewind gating', () => {
    const renderWithRewind = (deliveryStatus?: string) =>
      render(
        <SDKUserMessage
          message={{
            ...createTextMessage('Hello world'),
            ...(deliveryStatus ? { deliveryStatus } : {}),
          }}
          onRewind={() => {}}
          sessionId="s1"
        />
      );

    it('shows the rewind button for terminal delivered messages', () => {
      const { container } = renderWithRewind('delivered');
      expect(container.querySelector('[title="Rewind to here"]')).toBeTruthy();
    });

    it('shows the rewind button for terminal failed messages', () => {
      const { container } = renderWithRewind('failed');
      expect(container.querySelector('[title="Rewind to here"]')).toBeTruthy();
    });

    it('shows the rewind button when deliveryStatus is absent (legacy settled row)', () => {
      const { container } = renderWithRewind();
      expect(container.querySelector('[title="Rewind to here"]')).toBeTruthy();
    });

    it.each([
      'queued',
      'processing',
      'retrying',
    ])('hides the rewind button for nonterminal %s delivery', (status) => {
      const { container } = renderWithRewind(status);
      expect(container.querySelector('[title="Rewind to here"]')).toBeFalsy();
    });
  });

  describe('Styling', () => {
    it('should be right-aligned (user messages)', () => {
      const message = createTextMessage('Hello');
      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.querySelector('.justify-end')).toBeTruthy();
    });

    it('should have max-width constraint', () => {
      const message = createTextMessage('Hello');
      const { container } = render(<SDKUserMessage message={message} />);

      const wrapper = container.querySelector('.max-w-\\[85\\%\\]');
      expect(wrapper).toBeTruthy();
    });
  });

  describe('Reference Token Rendering', () => {
    function createMessageWithRef(
      text: string,
      referenceMetadata: Record<string, unknown> = {}
    ): Extract<SDKMessage, { type: 'user' }> {
      return {
        ...createTextMessage(text),
        referenceMetadata,
      } as unknown as Extract<SDKMessage, { type: 'user' }>;
    }

    it('renders plain text without @ref unchanged', () => {
      const message = createTextMessage('Hello @user how are you?');
      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.textContent).toContain('Hello @user how are you?');
      expect(container.querySelector('[data-testid="mention-token"]')).toBeNull();
    });

    it('renders @ref{task:t-1} as a MentionToken', () => {
      const message = createMessageWithRef('Fix @ref{task:t-1} now', {
        '@ref{task:t-1}': { type: 'task', id: 't-1', displayText: 'Login bug' },
      });
      const { container } = render(<SDKUserMessage message={message} />);

      const token = container.querySelector('[data-testid="mention-token"]');
      expect(token).toBeTruthy();
      expect(container.textContent).toContain('Login bug');
    });

    it('renders @ref{goal:g-1} as a MentionToken with correct type', () => {
      const message = createMessageWithRef('Work on @ref{goal:g-1}', {
        '@ref{goal:g-1}': { type: 'goal', id: 'g-1', displayText: 'Ship v2' },
      });
      const { container } = render(<SDKUserMessage message={message} />);

      const token = container.querySelector('[data-testid="mention-token"]');
      expect(token?.getAttribute('data-ref-type')).toBe('goal');
    });

    it('falls back to raw id when referenceMetadata is absent', () => {
      const message = createMessageWithRef('Fix @ref{task:t-99}');
      const { container } = render(<SDKUserMessage message={message} />);

      const token = container.querySelector('[data-testid="mention-token"]');
      expect(token).toBeTruthy();
      expect(container.textContent).toContain('t-99');
    });

    it('renders unknown reference type as styled plain text (not a token)', () => {
      const message = createTextMessage('See @ref{widget:w-1} here');
      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.querySelector('[data-testid="mention-token"]')).toBeNull();
      expect(container.textContent).toContain('@ref{widget:w-1}');
    });

    it('renders surrounding text around a token', () => {
      const message = createMessageWithRef('Please fix @ref{task:t-1} urgently', {
        '@ref{task:t-1}': { type: 'task', id: 't-1', displayText: 'Bug' },
      });
      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.textContent).toContain('Please fix');
      expect(container.textContent).toContain('urgently');
      expect(container.querySelector('[data-testid="mention-token"]')).toBeTruthy();
    });

    it('renders multiple tokens in a single message', () => {
      const message = createMessageWithRef('Fix @ref{task:t-1} and see @ref{file:src/foo.ts}', {
        '@ref{task:t-1}': { type: 'task', id: 't-1', displayText: 'Bug' },
        '@ref{file:src/foo.ts}': { type: 'file', id: 'src/foo.ts', displayText: 'foo.ts' },
      });
      const { container } = render(<SDKUserMessage message={message} />);

      const tokens = container.querySelectorAll('[data-testid="mention-token"]');
      expect(tokens).toHaveLength(2);
    });

    it('does not render mention-token for empty message text', () => {
      const message = createTextMessage('');
      const { container } = render(<SDKUserMessage message={message} />);

      expect(container.querySelector('[data-testid="mention-token"]')).toBeNull();
    });
  });
});
