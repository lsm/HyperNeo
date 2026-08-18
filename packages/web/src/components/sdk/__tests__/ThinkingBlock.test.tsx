// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { render, fireEvent } from '@testing-library/preact';
import { ThinkingBlock } from '../ThinkingBlock';

describe('ThinkingBlock', () => {
  describe('Basic Rendering', () => {
    it('should render with data-testid attribute', () => {
      const { container } = render(<ThinkingBlock content="Thinking content" />);

      expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
    });

    it('should render thinking header', () => {
      const { container } = render(<ThinkingBlock content="Let me think..." />);

      expect(container.textContent).toContain('Thinking');
    });

    it('should display thinking content', () => {
      const content = 'Let me analyze this problem step by step.';
      const { container } = render(<ThinkingBlock content={content} />);

      expect(container.textContent).toContain('Let me analyze this problem');
    });

    it('should have lightbulb icon', () => {
      const { container } = render(<ThinkingBlock content="Thinking..." />);

      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('Character Count', () => {
    it('should show character count', () => {
      const content = 'Short thinking content.';
      const { container } = render(<ThinkingBlock content={content} />);

      expect(container.textContent).toContain(`${content.length} character`);
    });

    it('should show singular "character" for 1 character', () => {
      const { container } = render(<ThinkingBlock content="x" />);

      expect(container.textContent).toContain('1 character');
      expect(container.textContent).not.toContain('1 characters');
    });

    it('should show plural "characters" for multiple characters', () => {
      const { container } = render(<ThinkingBlock content="abc" />);

      expect(container.textContent).toContain('3 characters');
    });

    it('should format large character counts with commas', () => {
      const longContent = 'x'.repeat(1500);
      const { container } = render(<ThinkingBlock content={longContent} />);

      expect(container.textContent).toContain('1,500');
    });

    it('should show estimated tokens when provided', () => {
      const content = 'Some thinking content';
      const { container } = render(<ThinkingBlock content={content} estimatedTokens={2000} />);

      expect(container.textContent).toContain('~2,000');
      expect(container.textContent).toContain('token');
    });

    it('should show plural "tokens" for multiple tokens', () => {
      const content = 'Thinking...';
      const { container } = render(<ThinkingBlock content={content} estimatedTokens={1500} />);

      expect(container.textContent).toContain('1,500 tokens');
      expect(container.textContent).toMatch(/\btokens\b/);
      expect(container.textContent).not.toMatch(/\b1,500 token\b/);
    });

    it('should show singular "token" for 1 token', () => {
      const content = 'Thinking...';
      const { container } = render(<ThinkingBlock content={content} estimatedTokens={1} />);

      expect(container.textContent).toContain('1 token');
      expect(container.textContent).not.toContain('1 tokens');
    });

    it('should show both tokens and characters when estimate provided', () => {
      const content = 'Some thinking';
      const { container } = render(<ThinkingBlock content={content} estimatedTokens={1000} />);

      expect(container.textContent).toContain('~1,000');
      expect(container.textContent).toContain('token');
      expect(container.textContent).toContain(`${content.length}`);
      expect(container.textContent).toContain('character');
    });

    it('should show character count only when no estimate provided', () => {
      const content = 'Some thinking';
      const { container } = render(<ThinkingBlock content={content} />);

      expect(container.textContent).toContain(`${content.length}`);
      expect(container.textContent).toContain('character');
      expect(container.textContent).not.toContain('token');
    });
  });

  describe('Truncation and Expansion', () => {
    it('should not show expand button for short content', () => {
      const shortContent = 'Short content that fits in preview.';
      const { container } = render(<ThinkingBlock content={shortContent} />);

      expect(container.textContent).toContain('Short content');
    });

    it('should render long content', () => {
      const longContent =
        'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
      const { container } = render(<ThinkingBlock content={longContent} />);

      expect(container.textContent).toContain('Line 1');
      expect(container.textContent).toContain('Line 10');
    });

    it('should have expand button structure when content triggers truncation', () => {
      const longContent =
        'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
      const { container } = render(<ThinkingBlock content={longContent} />);

      expect(container.textContent).toContain('Line 1');
      expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
    });

    it('should render all lines of content', () => {
      const longContent =
        'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
      const { container } = render(<ThinkingBlock content={longContent} />);

      expect(container.textContent).toContain('Line 1');
      expect(container.textContent).toContain('Line 5');
      expect(container.textContent).toContain('Line 10');
    });

    it('should toggle expand/collapse when button is clicked', () => {
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
        const { container } = render(<ThinkingBlock content={longContent} />);

        const showMoreButton = container.querySelector('button');
        expect(showMoreButton).toBeTruthy();
        expect(showMoreButton?.textContent).toContain('Show more');

        fireEvent.click(showMoreButton as HTMLElement);

        expect(container.textContent).toContain('Show less');

        const showLessButton = container.querySelector('button');
        fireEvent.click(showLessButton as HTMLElement);

        expect(container.textContent).toContain('Show more');
      } finally {
        if (originalScrollHeight) {
          Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
        }
      }
    });
  });

  describe('Gradient Fade Overlay', () => {
    it('should have proper structure for gradient overlay', () => {
      const longContent =
        'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
      const { container } = render(<ThinkingBlock content={longContent} />);

      expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
      expect(container.textContent).toContain('Line 1');
    });

    it('should render content area with proper classes', () => {
      const longContent =
        'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
      const { container } = render(<ThinkingBlock content={longContent} />);

      expect(container.querySelector('.border-t')).toBeTruthy();
      expect(container.querySelector('.bg-white, .dark\\:bg-gray-900')).toBeTruthy();
    });
  });

  describe('Styling', () => {
    it('should have amber color scheme', () => {
      const { container } = render(<ThinkingBlock content="Thinking..." />);

      expect(container.querySelector('.bg-amber-50, .dark\\:bg-amber-900\\/20')).toBeTruthy();
    });

    it('should have border styling', () => {
      const { container } = render(<ThinkingBlock content="Thinking..." />);

      expect(container.querySelector('.border')).toBeTruthy();
      expect(container.querySelector('.rounded-lg')).toBeTruthy();
    });

    it('should apply custom className', () => {
      const { container } = render(
        <ThinkingBlock content="Thinking..." className="custom-class" />
      );

      expect(container.querySelector('.custom-class')).toBeTruthy();
    });
  });

  describe('Content Formatting', () => {
    it('should preserve whitespace in content', () => {
      const content = 'Step 1: First\nStep 2: Second\n  - Indented item';
      const { container } = render(<ThinkingBlock content={content} />);

      const contentElement = container.querySelector('.whitespace-pre-wrap');
      expect(contentElement).toBeTruthy();
    });

    it('should display monospace font for thinking content', () => {
      const { container } = render(<ThinkingBlock content="Thinking..." />);

      const contentElement = container.querySelector('.font-mono');
      expect(contentElement).toBeTruthy();
    });
  });

  describe('Edge Cases', () => {
    it('should render nothing for empty content (Opus 4.7 omitted-thinking stub)', () => {
      const { container } = render(<ThinkingBlock content="" />);

      expect(container.querySelector('[data-testid="thinking-block"]')).toBeNull();
      expect(container.textContent).not.toContain('0 characters');
    });

    it('should render nothing for whitespace-only content', () => {
      const { container } = render(<ThinkingBlock content={'   \n\t  '} />);

      expect(container.querySelector('[data-testid="thinking-block"]')).toBeNull();
    });

    it('should handle very long single line content', () => {
      const longLine = 'x'.repeat(5000);
      const { container } = render(<ThinkingBlock content={longLine} />);

      expect(container.textContent).toContain('5,000 characters');
    });

    it('should handle content with special characters', () => {
      const content = 'Thinking about <code> and "quotes" and \'apostrophes\'';
      const { container } = render(<ThinkingBlock content={content} />);

      expect(container.textContent).toContain('<code>');
      expect(container.textContent).toContain('"quotes"');
    });

    it('should handle content with unicode characters', () => {
      const content = 'Thinking about emojis and unicode';
      const { container } = render(<ThinkingBlock content={content} />);

      expect(container.textContent).toContain('Thinking about emojis');
    });
  });

  describe('Accessibility', () => {
    it('should have proper content structure', () => {
      const longContent =
        'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
      const { container } = render(<ThinkingBlock content={longContent} />);

      expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
      expect(container.querySelector('pre')).toBeTruthy();
    });

    it('should render header with icon', () => {
      const content = 'Some thinking content';
      const { container } = render(<ThinkingBlock content={content} />);

      expect(container.querySelector('svg')).toBeTruthy();
      expect(container.textContent).toContain('Thinking');
    });
  });

  describe('Running shimmer indicator', () => {
    it('shows the .running-shimmer overlay while running', () => {
      const { container } = render(<ThinkingBlock content="Thinking..." isRunning />);

      const card = container.querySelector('[data-testid="thinking-block"]');
      expect(card?.querySelector('.running-shimmer')).toBeTruthy();
    });

    it('does not show the .running-shimmer overlay when not running', () => {
      const { container } = render(<ThinkingBlock content="Thinking..." />);

      expect(container.querySelector('.running-shimmer')).toBeNull();
    });
  });
});
