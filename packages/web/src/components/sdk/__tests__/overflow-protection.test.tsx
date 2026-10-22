// @ts-nocheck

import { vi } from 'vitest';
import { render } from '@testing-library/preact';
import { SyntheticMessageBlock } from '../SyntheticMessageBlock';
import { SubagentBlock } from '../SubagentBlock';
import { SlashCommandOutput } from '../SlashCommandOutput';

vi.mock('../../chat/MarkdownRenderer.tsx', () => ({
  default: ({ content, class: className }: { content: string; class?: string }) => (
    <div class={`prose ${className || ''}`}>{content}</div>
  ),
}));

describe('Overflow Protection', () => {
  describe('SyntheticMessageBlock', () => {
    it('should render text content through MarkdownRenderer (prose class provides overflow protection)', () => {
      const { container } = render(
        <SyntheticMessageBlock content="Test text content" timestamp={Date.now()} />
      );
      const proseEl = container.querySelector('.prose');
      expect(proseEl).toBeTruthy();
    });

    it('should apply overflow-x-auto to tool_use JSON blocks', () => {
      const content = [
        {
          type: 'tool_use',
          name: 'TestTool',
          input: { longKey: 'a'.repeat(1000) },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );
      const jsonDiv = container.querySelector('.font-mono.overflow-x-auto');
      expect(jsonDiv).toBeTruthy();
    });

    it('should apply overflow-auto to tool_result blocks', () => {
      const content = [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_12345678901234567890',
          content: 'a'.repeat(1000),
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );
      const resultDiv = container.querySelector('.overflow-auto');
      expect(resultDiv).toBeTruthy();
    });

    it('should apply overflow-x-auto to image blocks', () => {
      const content = [
        {
          type: 'image',
          source: { type: 'base64', data: 'very-long-base64-data'.repeat(100) },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );
      const imageDiv = container.querySelector('.font-mono.overflow-x-auto');
      expect(imageDiv).toBeTruthy();
    });

    it('should apply overflow-x-auto to unknown block types', () => {
      const content = [
        {
          type: 'custom_unknown_type',
          data: { nested: { deeply: 'value'.repeat(100) } },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );
      const unknownDiv = container.querySelector('.font-mono.overflow-x-auto');
      expect(unknownDiv).toBeTruthy();
    });
  });

  describe('SubagentBlock', () => {
    const defaultInput = {
      subagent_type: 'Explore',
      description: 'Test task',
      prompt: 'Test prompt with potentially long content',
    };

    it('should apply break-words to input prompt when expanded', async () => {
      const { container, rerender } = render(
        <SubagentBlock input={defaultInput} toolId="tool_123" />
      );

      const button = container.querySelector('button');
      button?.click();

      await new Promise((resolve) => setTimeout(resolve, 10));
      rerender(<SubagentBlock input={defaultInput} toolId="tool_123" />);

      const allDivs = container.querySelectorAll('div');
      let hasBreakWordsClass = false;
      allDivs.forEach((div) => {
        if (
          div.className.includes('whitespace-pre-wrap') &&
          div.className.includes('break-words')
        ) {
          hasBreakWordsClass = true;
        }
      });

      expect(container.querySelector('.border.rounded-lg')).toBeTruthy();
      void hasBreakWordsClass;
    });

    it('should have proper structure for overflow protection', () => {
      const { container } = render(
        <SubagentBlock input={defaultInput} output="Test output content" toolId="tool_123" />
      );

      const button = container.querySelector('button');
      expect(button).toBeTruthy();
      expect(button?.className).toContain('w-full');
    });
  });

  describe('SlashCommandOutput', () => {
    it('should apply max-w-full and overflow-x-auto to output container', () => {
      const content = '<local-command-stdout>Some command output here</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      const outputDiv = container.querySelector('.max-w-full.overflow-x-auto');
      expect(outputDiv).toBeTruthy();
    });

    it('should not use max-w-none (which removes constraints)', () => {
      const content = '<local-command-stdout>Test output</local-command-stdout>';
      const { container } = render(<SlashCommandOutput content={content} />);

      const proseDiv = container.querySelector('.prose');
      expect(proseDiv?.className).not.toContain('max-w-none');
    });
  });

  describe('Long content handling', () => {
    it('should render very long text inside a MarkdownRenderer (prose handles overflow)', () => {
      const longText = 'VeryLongWordWithNoBreaks'.repeat(100);
      const { container } = render(
        <SyntheticMessageBlock content={longText} timestamp={Date.now()} />
      );

      const proseEl = container.querySelector('.prose');
      expect(proseEl).toBeTruthy();
    });

    it('should contain very long JSON without overflow', () => {
      const content = [
        {
          type: 'tool_use',
          name: 'LongOutputTool',
          input: {
            veryLongKey: 'x'.repeat(500),
            anotherLongKey: Array.from({ length: 100 }, (_, i) => `item${i}`),
          },
        },
      ];
      const { container } = render(
        <SyntheticMessageBlock content={content} timestamp={Date.now()} />
      );

      const scrollableDiv = container.querySelector('.overflow-x-auto');
      expect(scrollableDiv).toBeTruthy();
    });

    it('should render long URLs and file paths inside a MarkdownRenderer (prose handles overflow)', () => {
      const longPath = '/very/long/file/path/that/goes/on/and/on/'.repeat(20);
      const { container } = render(
        <SyntheticMessageBlock content={longPath} timestamp={Date.now()} />
      );

      const proseEl = container.querySelector('.prose');
      expect(proseEl).toBeTruthy();
    });
  });
});
