// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';

import { render } from '@testing-library/preact';
import { SlashCommandOutput, isHiddenCommandOutput } from '../SlashCommandOutput';

vi.mock('../../chat/MarkdownRenderer.tsx', () => ({
  default: ({ content, class: className }: { content: string; class?: string }) => (
    <div data-testid="markdown-renderer" class={className}>
      {content}
    </div>
  ),
}));

describe('SlashCommandOutput', () => {
  describe('Basic Rendering', () => {
    it('should render command output content', () => {
      const content = '<local-command-stdout>Command executed successfully</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.textContent).toContain('Command executed successfully');
    });

    it('should show "Command Output" header', () => {
      const content = '<local-command-stdout>Test output</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.textContent).toContain('Command Output');
    });

    it('should have terminal icon', () => {
      const content = '<local-command-stdout>Output</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('Parsing', () => {
    it('should extract content from local-command-stdout tags', () => {
      const content = '<local-command-stdout>Extracted content here</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.textContent).toContain('Extracted content here');
    });

    it('should handle multiline content', () => {
      const content = `<local-command-stdout>Line 1
Line 2
Line 3</local-command-stdout>`;
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.textContent).toContain('Line 1');
      expect(container.textContent).toContain('Line 2');
      expect(container.textContent).toContain('Line 3');
    });

    it('should trim whitespace from extracted content', () => {
      const content = '<local-command-stdout>  Trimmed content  </local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.textContent).toContain('Trimmed content');
    });

    it('should return null for content without stdout tags', () => {
      const content = 'Regular text without tags';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.innerHTML).toBe('');
    });

    it('should return null for content with stderr tags only', () => {
      const content = '<local-command-stderr>Error message</local-command-stderr>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.innerHTML).toBe('');
    });

    it('should handle content with both stdout and surrounding text', () => {
      const content = 'Before <local-command-stdout>Output</local-command-stdout> After';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.textContent).toContain('Output');
    });
  });

  describe('Hidden Outputs', () => {
    it('should not render "Compacted" output', () => {
      const content = '<local-command-stdout>Compacted</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.innerHTML).toBe('');
    });

    it('should render other outputs normally', () => {
      const content = '<local-command-stdout>Not hidden</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.textContent).toContain('Not hidden');
    });
  });

  describe('isHiddenCommandOutput Helper', () => {
    it('should return true for "Compacted" output', () => {
      const content = '<local-command-stdout>Compacted</local-command-stdout>';
      expect(isHiddenCommandOutput(content)).toBe(true);
    });

    it('should return false for regular output', () => {
      const content = '<local-command-stdout>Regular output</local-command-stdout>';
      expect(isHiddenCommandOutput(content)).toBe(false);
    });

    it('should return false for content without stdout tags', () => {
      const content = 'No tags here';
      expect(isHiddenCommandOutput(content)).toBe(false);
    });

    it('should return false for empty stdout content', () => {
      const content = '<local-command-stdout></local-command-stdout>';
      expect(isHiddenCommandOutput(content)).toBe(false);
    });
  });

  describe('Styling', () => {
    it('should have dark background styling', () => {
      const content = '<local-command-stdout>Output</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.querySelector('.bg-surface-raised\\/60')).toBeTruthy();
    });

    it('should have border styling', () => {
      const content = '<local-command-stdout>Output</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.querySelector('.border')).toBeTruthy();
    });

    it('should have rounded corners', () => {
      const content = '<local-command-stdout>Output</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.querySelector('.rounded-lg')).toBeTruthy();
    });

    it('should apply custom className', () => {
      const content = '<local-command-stdout>Output</local-command-stdout>';
      const { container } = render(
        <SlashCommandOutput content={content} className="custom-class" />
      );

      expect(container.querySelector('.custom-class')).toBeTruthy();
    });
  });

  describe('Markdown Rendering', () => {
    it('should pass markdown content to MarkdownRenderer', () => {
      const content =
        '<local-command-stdout># Heading\n\nSome **bold** text.</local-command-stdout>';
      const { getByTestId } = render(<SlashCommandOutput content={content} />);

      const markdownRenderer = getByTestId('markdown-renderer');
      expect(markdownRenderer.textContent).toBe('# Heading\n\nSome **bold** text.');
      expect(markdownRenderer.className).toContain('text-sm');
    });

    it('should pass code blocks to MarkdownRenderer unchanged', () => {
      const content = '<local-command-stdout>```\ncode here\n```</local-command-stdout>';
      const { getByTestId } = render(<SlashCommandOutput content={content} />);

      expect(getByTestId('markdown-renderer').textContent).toBe('```\ncode here\n```');
    });

    it('should pass lists to MarkdownRenderer unchanged', () => {
      const content = '<local-command-stdout>- Item 1\n- Item 2\n- Item 3</local-command-stdout>';
      const { getByTestId } = render(<SlashCommandOutput content={content} />);

      expect(getByTestId('markdown-renderer').textContent).toBe('- Item 1\n- Item 2\n- Item 3');
    });
  });

  describe('Overflow Protection', () => {
    it('should have max-w-full class', () => {
      const content = '<local-command-stdout>Output</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.querySelector('.max-w-full')).toBeTruthy();
    });

    it('should have overflow-x-auto for horizontal scrolling', () => {
      const content =
        '<local-command-stdout>Very long output that might overflow</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.querySelector('.overflow-x-auto')).toBeTruthy();
    });

    it('should not have max-w-none (which removes constraints)', () => {
      const content = '<local-command-stdout>Output</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      const proseDiv = container.querySelector('.prose');
      expect(proseDiv?.className).not.toContain('max-w-none');
    });
  });

  describe('Prose Styling', () => {
    it('should have prose class for typography', () => {
      const content = '<local-command-stdout>Output</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.querySelector('.prose')).toBeTruthy();
    });

    it('should have prose-invert for dark mode', () => {
      const content = '<local-command-stdout>Output</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.querySelector('.prose-invert')).toBeTruthy();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content', () => {
      const { container } = render(<SlashCommandOutput content="" />);

      expect(container.innerHTML).toBe('');
    });

    it('should handle whitespace-only content in tags', () => {
      const content = '<local-command-stdout>   </local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.innerHTML).not.toContain('undefined');
    });

    it('should handle special characters in output', () => {
      const content =
        '<local-command-stdout>Special chars: `<>` & "\' and unicode</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.textContent).toContain('Special chars');
      expect(container.textContent).toContain('<>');
      expect(container.textContent).toContain('&');
    });

    it('should handle very long output', () => {
      const longOutput = 'x'.repeat(10000);
      const content = `<local-command-stdout>${longOutput}</local-command-stdout>`;
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.textContent).toContain('x');
    });

    it('should handle output with nested angle brackets', () => {
      const content = '<local-command-stdout>Result: {count: 5}</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.textContent).toContain('Result');
      expect(container.textContent).toContain('count');
    });
  });

  describe('Command Types', () => {
    it('should render /help command output', () => {
      const content =
        '<local-command-stdout>Available commands:\n- /help\n- /clear\n- /compact</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.textContent).toContain('Available commands');
      expect(container.textContent).toContain('/help');
    });

    it('should render /context command output', () => {
      const content = '<local-command-stdout>Context: 50,000 tokens used</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.textContent).toContain('Context');
      expect(container.textContent).toContain('50,000 tokens');
    });

    it('should render /cost command output', () => {
      const content = '<local-command-stdout>Total cost: $0.0125</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      expect(container.textContent).toContain('Total cost');
      expect(container.textContent).toContain('$0.0125');
    });
  });
});
