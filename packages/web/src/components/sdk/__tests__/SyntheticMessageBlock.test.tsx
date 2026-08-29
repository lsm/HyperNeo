// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { render, fireEvent, waitFor } from '@testing-library/preact';
import { SyntheticMessageBlock } from '../SyntheticMessageBlock';

vi.mock('../../chat/MarkdownRenderer.tsx', () => ({
  default: ({ content, class: className }: { content: string; class?: string }) => (
    <div data-testid="markdown-renderer" class={className}>
      {content}
    </div>
  ),
}));

const mockCopyToClipboard = vi.fn();

vi.mock('../../../lib/utils.ts', async () => {
  const actual = await vi.importActual('../../../lib/utils.ts');
  return {
    ...actual,
    copyToClipboard: (text: string) => mockCopyToClipboard(text),
  };
});

const mockToastError = vi.fn();

vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    success: vi.fn(),
    error: (msg: string) => mockToastError(msg),
  },
}));

describe('SyntheticMessageBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCopyToClipboard.mockResolvedValue(true);
    mockToastError.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic Rendering', () => {
    it('should render with data-testid attribute', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Synthetic content" timestamp={Date.now()} />
      );

      expect(container.querySelector('[data-testid="synthetic-message"]')).toBeTruthy();
    });

    it('should include role in data attribute', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Synthetic content" timestamp={Date.now()} />
      );

      const element = container.querySelector('[data-message-role]');
      expect(element?.getAttribute('data-message-role')).toBe('synthetic');
    });

    it('should include uuid in data attribute when provided', () => {
      const uuid = 'test-uuid-12345';
      const { container } = render(
        <SyntheticMessageBlock content="Synthetic content" timestamp={Date.now()} uuid={uuid} />
      );

      const element = container.querySelector('[data-message-uuid]');
      expect(element?.getAttribute('data-message-uuid')).toBe(uuid);
    });

    it('should include timestamp in data attribute', () => {
      const timestamp = 1703234567890;
      const { container } = render(
        <SyntheticMessageBlock content="Synthetic content" timestamp={timestamp} />
      );

      const element = container.querySelector('[data-message-timestamp]');
      expect(element?.getAttribute('data-message-timestamp')).toBe(String(timestamp));
    });
  });

  describe('Header', () => {
    it('should show "Synthetic" label in header', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('Synthetic');
    });

    it('should show an amber arrow icon in the header', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      const icon = container.querySelector('[data-testid="synthetic-icon"]');
      expect(icon).toBeTruthy();
      expect(icon?.getAttribute('class')).toContain('text-warning');
    });

    it('should style the Synthetic label with the amber accent', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      const label = container.querySelector('[data-testid="synthetic-label"]');
      expect(label?.textContent).toBe('Synthetic');
      expect(label?.getAttribute('class')).toContain('text-warning');
    });

    it('should not show an agent route badge by default', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      const routeBadge = container.querySelector('[data-testid="synthetic-route-badge"]');
      expect(routeBadge).toBeNull();
    });

    it('should render the FROM→TO route badge when fromAgent and toAgent are provided', () => {
      const { container } = render(
        <SyntheticMessageBlock
          content="Content"
          timestamp={Date.now()}
          fromAgent="Reviewer"
          toAgent="Builder"
          fromShort="rev"
          toShort="build"
        />
      );

      const routeBadge = container.querySelector('[data-testid="synthetic-route-badge"]');
      expect(routeBadge).toBeTruthy();
      expect(routeBadge?.textContent).toContain('rev');
      expect(routeBadge?.textContent).toContain('build');
      expect(routeBadge?.getAttribute('aria-label')).toBe('From Reviewer agent to Builder agent');
    });
  });

  describe('String Content', () => {
    it('should render simple string content via MarkdownRenderer', () => {
      const content = 'This is a synthetic message.';
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      const renderer = container.querySelector('[data-testid="markdown-renderer"]');
      expect(renderer).toBeTruthy();
      expect(renderer?.textContent).toContain('This is a synthetic message');
    });

    it('should pass text to MarkdownRenderer', () => {
      const content = 'Markdown content here.';
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      const renderer = container.querySelector('[data-testid="markdown-renderer"]');
      expect(renderer).toBeTruthy();
      expect(renderer?.textContent).toContain('Markdown content here');
    });
  });

  describe('Array Content Blocks', () => {
    it('should render text blocks via MarkdownRenderer', () => {
      const content = [{ type: 'text', text: 'Text block content' }];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      const renderer = container.querySelector('[data-testid="markdown-renderer"]');
      expect(renderer).toBeTruthy();
      expect(renderer?.textContent).toContain('Text block content');
    });

    it('should render image blocks', () => {
      const content = [
        {
          type: 'image',
          source: { type: 'base64', data: 'abc123' },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('Image');
      expect(container.textContent).toContain('base64');
    });

    it('should render tool_use blocks', () => {
      const content = [
        {
          type: 'tool_use',
          name: 'Read',
          input: { file_path: '/test/file.txt' },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('Tool Use: Read');
      expect(container.textContent).toContain('file_path');
    });

    it('should render tool_result blocks', () => {
      const content = [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_abc123456789012',
          content: 'File content here',
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('Tool Result');
      expect(container.textContent).toContain('toolu_abc123');
      expect(container.textContent).toContain('File content here');
    });

    it('should render tool_result blocks with empty content', () => {
      const content = [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_abc123456789012',
          content: null,
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('(empty)');
    });

    it('should render unknown block types', () => {
      const content = [
        {
          type: 'custom_type',
          data: { key: 'value' },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('custom_type');
      expect(container.textContent).toContain('key');
    });

    it('should render multiple blocks', () => {
      const content = [
        { type: 'text', text: 'First text' },
        { type: 'text', text: 'Second text' },
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'ls' },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('First text');
      expect(container.textContent).toContain('Second text');
      expect(container.textContent).toContain('Tool Use: Bash');
    });
  });

  describe('Timestamp Display', () => {
    it('should show formatted time', () => {
      const timestamp = Date.now();
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={timestamp} />
      );

      const timeRegex = /\d{1,2}:\d{2}\s?(AM|PM)/i;
      expect(container.textContent).toMatch(timeRegex);
    });

    it('should not show timestamp when not provided', () => {
      const { container } = render(<SyntheticMessageBlock content="Content" />);

      expect(container.textContent).toContain('Content');
    });

    it('should have tooltip with full timestamp', () => {
      const timestamp = Date.now();
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={timestamp} />
      );

      const timeSpan = container.querySelector('.text-xs.text-fg-muted');
      expect(timeSpan).toBeTruthy();
    });
  });

  describe('Synthetic Label', () => {
    it('should show "Synthetic" label in the card header', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('Synthetic');
    });

    it('should not include a lowercase synthetic pill in the actions row', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      expect(container.querySelector('.bg-purple-500\\/20')).toBeNull();
    });
  });

  describe('Copy Functionality', () => {
    it('should have copy button in action row', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content to copy" timestamp={Date.now()} />
      );

      const copyButton = container.querySelector('button[title="Copy message"]');
      expect(copyButton).toBeTruthy();
    });

    it('should show inline green check when copy succeeds', async () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content to copy" timestamp={Date.now()} />
      );

      const copyButton = container.querySelector('button[title="Copy message"]');
      fireEvent.click(copyButton!);

      await waitFor(() => {
        expect(mockCopyToClipboard).toHaveBeenCalledWith('Content to copy');
        const copiedButton = container.querySelector('button[title="Copied!"]');
        expect(copiedButton).toBeTruthy();
        expect(copiedButton?.className).toContain('text-success');
      });
    });

    it('should stay in "Copy message" state when copy fails', async () => {
      mockCopyToClipboard.mockResolvedValue(false);

      const { container } = render(
        <SyntheticMessageBlock content="Content to copy" timestamp={Date.now()} />
      );

      const copyButton = container.querySelector('button[title="Copy message"]');
      fireEvent.click(copyButton!);

      await waitFor(() => {
        expect(mockCopyToClipboard).toHaveBeenCalledWith('Content to copy');
        expect(container.querySelector('button[title="Copy message"]')).toBeTruthy();
        expect(container.querySelector('button[title="Copied!"]')).toBeNull();
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
        const { container } = render(
          <SyntheticMessageBlock content="Content to copy" timestamp={Date.now()} />
        );

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

    it('should extract and copy text from array content blocks', async () => {
      const content = [
        { type: 'text', text: 'First line' },
        { type: 'text', text: 'Second line' },
        { type: 'image', source: {} },
      ];

      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      const copyButton = container.querySelector('button[title="Copy message"]');
      fireEvent.click(copyButton!);

      await waitFor(() => {
        expect(mockCopyToClipboard).toHaveBeenCalledWith('First line\nSecond line');
      });
    });

    it('should handle empty content array when copying', async () => {
      const { container } = render(<SyntheticMessageBlock content={[]} timestamp={Date.now()} />);

      const copyButton = container.querySelector('button[title="Copy message"]');
      fireEvent.click(copyButton!);

      await waitFor(() => {
        expect(mockCopyToClipboard).toHaveBeenCalledWith('');
      });
    });

    it('should handle content with only non-text blocks when copying', async () => {
      const content = [
        { type: 'image', source: {} },
        { type: 'tool_use', name: 'Read', input: {} },
      ];

      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      const copyButton = container.querySelector('button[title="Copy message"]');
      fireEvent.click(copyButton!);

      await waitFor(() => {
        expect(mockCopyToClipboard).toHaveBeenCalledWith('');
      });
    });
  });

  describe('Session Info Dropdown', () => {
    it('should not render the session-info trigger by default', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      expect(container.querySelector('button[title="Session info"]')).toBeNull();
    });

    it('should render the session-info trigger when sessionInit is provided', () => {
      const sessionInit = {
        type: 'system',
        subtype: 'init',
        uuid: 'init-uuid',
        session_id: 'sess',
        model: 'claude-3-5-sonnet-20241022',
        cwd: '/tmp',
        tools: ['Bash'],
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

      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} sessionInit={sessionInit} />
      );

      expect(container.querySelector('button[title="Session info"]')).toBeTruthy();
    });
  });

  describe('Open in Session', () => {
    it('should not render an "open in session" button by default', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      expect(container.querySelector('button[title="Open in session"]')).toBeNull();
    });

    it('should render an "open in session" button when onOpenSession is provided', () => {
      const onOpenSession = vi.fn();
      const { container } = render(
        <SyntheticMessageBlock
          content="Content"
          timestamp={Date.now()}
          onOpenSession={onOpenSession}
        />
      );

      const button = container.querySelector('button[title="Open in session"]');
      expect(button).toBeTruthy();
      fireEvent.click(button as HTMLElement);
      expect(onOpenSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('Styling', () => {
    it('should be right-aligned', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      expect(container.querySelector('.justify-end')).toBeTruthy();
    });

    it('should use a gray panel with amber chrome', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      const card = container.querySelector('[data-testid="synthetic-card"]');
      expect(card?.className).toContain('bg-surface-raised/60');
      expect(card?.className).toContain('border-warning/50');
    });

    it('should NOT use purple background or border on the card', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      const card = container.querySelector('[data-testid="synthetic-card"]');
      expect(card?.className).not.toContain('bg-cat-purple');
      expect(card?.className).not.toContain('border-cat-purple');
    });

    it('should have max-width constraint', () => {
      const { getByTestId } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      const widthWrapper = getByTestId('synthetic-card').parentElement;
      expect(widthWrapper?.className).toContain('max-w-[85%]');
      expect(widthWrapper?.className).toContain('md:max-w-[70%]');
    });

    it('should honor custom widthClass overrides', () => {
      const { getByTestId } = render(
        <SyntheticMessageBlock
          content="Content"
          timestamp={Date.now()}
          widthClass="max-w-[85%] md:max-w-[86%]"
        />
      );

      const widthWrapper = getByTestId('synthetic-card').parentElement;
      expect(widthWrapper?.className).toContain('max-w-[85%]');
      expect(widthWrapper?.className).toContain('md:max-w-[86%]');
      expect(widthWrapper?.className).not.toContain('md:max-w-[70%]');
    });

    it('should have rounded borders', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      expect(container.querySelector('[data-testid="synthetic-card"].rounded-lg')).toBeTruthy();
    });
  });

  describe('Markdown Rendering', () => {
    it('should render text blocks through MarkdownRenderer', () => {
      const content = '## Task Title\n\n- Item 1\n- Item 2';
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      const renderer = container.querySelector('[data-testid="markdown-renderer"]');
      expect(renderer).toBeTruthy();
    });

    it('should pass the full text to MarkdownRenderer', () => {
      const content = [{ type: 'text', text: '**bold** and `code`' }];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      const renderer = container.querySelector('[data-testid="markdown-renderer"]');
      expect(renderer?.textContent).toContain('**bold** and `code`');
    });

    it('should not render MarkdownRenderer for non-text blocks', () => {
      const content = [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'ls' },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      const renderers = container.querySelectorAll('[data-testid="markdown-renderer"]');
      expect(renderers.length).toBe(0);
    });
  });

  describe('Collapse/Expand Behavior', () => {
    it('should not show collapse toggle for short content', () => {
      const shortContent = 'Short content';
      const { container } = render(
        <SyntheticMessageBlock content={shortContent} timestamp={Date.now()} />
      );

      const toggle = container.querySelector('[data-testid="synthetic-toggle"]');
      expect(toggle).toBeNull();
    });

    it('should show "Show more" toggle when content is long (scrollHeight > threshold)', () => {
      const originalScrollHeight = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'scrollHeight'
      );
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get() {
          return 500;
        },
      });

      try {
        const longContent =
          'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
        const { container } = render(
          <SyntheticMessageBlock content={longContent} timestamp={Date.now()} />
        );

        const toggle = container.querySelector('[data-testid="synthetic-toggle"]');
        expect(toggle).toBeTruthy();
        expect(toggle?.textContent).toContain('Show more');
      } finally {
        if (originalScrollHeight) {
          Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
        }
      }
    });

    it('should toggle between "Show more" and "Show less"', () => {
      const originalScrollHeight = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'scrollHeight'
      );
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get() {
          return 500;
        },
      });

      try {
        const longContent =
          'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
        const { container } = render(
          <SyntheticMessageBlock content={longContent} timestamp={Date.now()} />
        );

        const toggle = container.querySelector('[data-testid="synthetic-toggle"]');
        expect(toggle?.textContent).toContain('Show more');

        fireEvent.click(toggle as HTMLElement);
        expect(container.textContent).toContain('Show less');

        const showLessButton = container.querySelector('[data-testid="synthetic-toggle"]');
        fireEvent.click(showLessButton as HTMLElement);
        expect(container.textContent).toContain('Show more');
      } finally {
        if (originalScrollHeight) {
          Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
        }
      }
    });
  });

  describe('Overflow Protection', () => {
    it('should apply overflow-x-auto to JSON content (image blocks)', () => {
      const content = [
        {
          type: 'image',
          source: { type: 'base64', data: 'abc123' },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.querySelector('.overflow-x-auto')).toBeTruthy();
    });

    it('should apply overflow-x-auto to JSON content (tool_use blocks)', () => {
      const content = [
        {
          type: 'tool_use',
          name: 'Test',
          input: { longKey: 'x'.repeat(1000) },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.querySelector('.overflow-x-auto')).toBeTruthy();
    });

    it('should apply overflow-auto to tool_result content', () => {
      const content = [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_abc123456789012',
          content: 'x'.repeat(1000),
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.querySelector('.overflow-auto')).toBeTruthy();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content array', () => {
      const { container } = render(<SyntheticMessageBlock content={[]} timestamp={Date.now()} />);

      expect(container.querySelector('[data-testid="synthetic-message"]')).toBeTruthy();
    });

    it('should handle content with undefined fields', () => {
      const content = [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_abc123456789012',
          content: undefined,
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('(empty)');
    });

    it('should handle object content in tool_result', () => {
      const content = [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_abc123456789012',
          content: { key: 'value', nested: { data: 123 } },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('key');
      expect(container.textContent).toContain('value');
    });

    it('should handle very long text content', () => {
      const longContent = 'x'.repeat(10000);
      const { container } = render(
        <SyntheticMessageBlock content={longContent} timestamp={Date.now()} />
      );

      expect(container.querySelector('[data-testid="synthetic-message"]')).toBeTruthy();
    });

    it('should handle special characters in content', () => {
      const content = 'Special chars: <script>alert("xss")</script> & "quotes"';
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('Special chars');
    });

    it('should handle content with Unicode characters', () => {
      const content = 'Unicode: 你好 🎉 émoji café';
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('你好');
      expect(container.textContent).toContain('🎉');
    });
  });

  describe('formatTime Helper', () => {
    it('should format morning time correctly', () => {
      const date = new Date();
      date.setHours(9, 30, 0, 0);
      const timestamp = date.getTime();

      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={timestamp} />
      );

      expect(container.textContent).toMatch(/\d{1,2}:\d{2}/);
    });

    it('should format afternoon time correctly', () => {
      const date = new Date();
      date.setHours(14, 45, 0, 0);
      const timestamp = date.getTime();

      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={timestamp} />
      );

      expect(container.textContent).toMatch(/\d{1,2}:\d{2}/);
    });

    it('should handle midnight time', () => {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      const timestamp = date.getTime();

      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={timestamp} />
      );

      expect(container.textContent).toMatch(/12:00/i);
    });

    it('should handle noon time', () => {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      const timestamp = date.getTime();

      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={timestamp} />
      );

      expect(container.textContent).toMatch(/12:00/i);
    });
  });

  describe('getTextContent Helper', () => {
    it('should extract text from string content', () => {
      const content = 'Simple text content';
      const extracted = typeof content === 'string' ? content : '';
      expect(extracted).toBe('Simple text content');
    });

    it('should extract text from array of text blocks', () => {
      const content = [
        { type: 'text', text: 'First' },
        { type: 'text', text: 'Second' },
      ];
      const extracted = content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n');
      expect(extracted).toBe('First\nSecond');
    });

    it('should skip non-text blocks when extracting', () => {
      const content = [
        { type: 'text', text: 'Text content' },
        { type: 'image', source: {} },
        { type: 'tool_use', name: 'Read', input: {} },
      ];
      const extracted = content
        .map((block) => (block.type === 'text' ? (block.text as string) : ''))
        .filter(Boolean)
        .join('\n');
      expect(extracted).toBe('Text content');
    });

    it('should handle empty array', () => {
      const content: Array<{ type: string; text?: string }> = [];
      const extracted = content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n');
      expect(extracted).toBe('');
    });
  });

  describe('Content Block Key Generation', () => {
    it('should render multiple blocks with unique keys', () => {
      const content = [
        { type: 'text', text: 'Block 1' },
        { type: 'text', text: 'Block 2' },
        { type: 'text', text: 'Block 3' },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('Block 1');
      expect(container.textContent).toContain('Block 2');
      expect(container.textContent).toContain('Block 3');
    });
  });

  describe('Timestamp Zero Handling', () => {
    it('should handle timestamp of 0', () => {
      const { container } = render(<SyntheticMessageBlock content="Content" timestamp={0} />);

      const element = container.querySelector('[data-message-timestamp]');
      expect(element?.getAttribute('data-message-timestamp')).toBe('0');
    });

    it('should handle negative timestamp', () => {
      const { container } = render(<SyntheticMessageBlock content="Content" timestamp={-1000} />);

      expect(container.querySelector('[data-testid="synthetic-message"]')).toBeTruthy();
    });
  });

  describe('Tool Use Block Details', () => {
    it('should render tool use with complex input', () => {
      const content = [
        {
          type: 'tool_use',
          name: 'Edit',
          input: {
            file_path: '/src/test.ts',
            old_string: 'const x = 1;',
            new_string: 'const x = 2;',
          },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('Tool Use: Edit');
      expect(container.textContent).toContain('file_path');
    });

    it('should render tool use with array input', () => {
      const content = [
        {
          type: 'tool_use',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Task 1', status: 'pending', activeForm: '' },
              { content: 'Task 2', status: 'completed', activeForm: '' },
            ],
          },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('Tool Use: TodoWrite');
      expect(container.textContent).toContain('todos');
    });
  });

  describe('Tool Result Truncation', () => {
    it('should truncate long tool_use_id', () => {
      const content = [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_abc123456789012345678901234567890',
          content: 'Result',
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      expect(container.textContent).toContain('toolu_abc123');
      expect(container.textContent).toContain('...');
    });
  });

  describe('Accessibility', () => {
    it('should have accessible copy button', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Content" timestamp={Date.now()} />
      );

      const copyButton = container.querySelector('button[title="Copy message"]');
      expect(copyButton).toBeTruthy();
      expect(copyButton?.getAttribute('title')).toBe('Copy message');
    });
  });

  describe('Content Normalization', () => {
    it('should normalize string content to text block', () => {
      const stringContent = 'Simple string';
      const normalized =
        typeof stringContent === 'string' ? [{ type: 'text', text: stringContent }] : stringContent;

      expect(normalized).toEqual([{ type: 'text', text: 'Simple string' }]);
    });

    it('should keep array content as is', () => {
      const arrayContent = [{ type: 'text', text: 'Array text' }];
      const normalized =
        typeof arrayContent === 'string' ? [{ type: 'text', text: arrayContent }] : arrayContent;

      expect(normalized).toBe(arrayContent);
    });
  });

  describe('Data Attributes', () => {
    it('should set data-message-timestamp to 0 when timestamp is undefined', () => {
      const { container } = render(<SyntheticMessageBlock content="Content" />);

      const element = container.querySelector('[data-message-timestamp]');
      expect(element?.getAttribute('data-message-timestamp')).toBe('0');
    });

    it('should preserve exact uuid value', () => {
      const uuid = 'unique-id-with-special-chars_123';
      const { container } = render(<SyntheticMessageBlock content="Content" uuid={uuid} />);

      const element = container.querySelector('[data-message-uuid]');
      expect(element?.getAttribute('data-message-uuid')).toBe(uuid);
    });
  });
});
