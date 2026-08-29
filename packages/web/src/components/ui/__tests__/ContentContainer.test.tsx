// @ts-nocheck

import { render } from '@testing-library/preact';
import { describe, it, expect } from 'vitest';
import { ContentContainer } from '../ContentContainer';

describe('ContentContainer', () => {
  describe('Rendering', () => {
    it('should render children', () => {
      const { container } = render(
        <ContentContainer>
          <p>Test content</p>
        </ContentContainer>
      );
      const content = container.querySelector('p');
      expect(content?.textContent).toBe('Test content');
    });

    it('should render multiple children', () => {
      const { container } = render(
        <ContentContainer>
          <p>First child</p>
          <p>Second child</p>
        </ContentContainer>
      );
      const paragraphs = container.querySelectorAll('p');
      expect(paragraphs.length).toBe(2);
    });

    it('should render text children', () => {
      const { container } = render(<ContentContainer>Plain text content</ContentContainer>);
      const div = container.querySelector('div');
      expect(div?.textContent).toBe('Plain text content');
    });

    it('should render nested components', () => {
      const { container } = render(
        <ContentContainer>
          <div class="outer">
            <div class="inner">Nested</div>
          </div>
        </ContentContainer>
      );
      const outer = container.querySelector('.outer');
      const inner = container.querySelector('.inner');
      expect(outer).toBeTruthy();
      expect(inner).toBeTruthy();
      expect(inner?.textContent).toBe('Nested');
    });
  });

  describe('Default Classes', () => {
    it('should have mx-auto class for centering', () => {
      const { container } = render(
        <ContentContainer>
          <p>Content</p>
        </ContentContainer>
      );
      const div = container.querySelector('div');
      expect(div?.className).toContain('mx-auto');
    });

    it('should have px-4 class for horizontal padding', () => {
      const { container } = render(
        <ContentContainer>
          <p>Content</p>
        </ContentContainer>
      );
      const div = container.querySelector('div');
      expect(div?.className).toContain('px-4');
    });

    it('should have w-full class', () => {
      const { container } = render(
        <ContentContainer>
          <p>Content</p>
        </ContentContainer>
      );
      const div = container.querySelector('div');
      expect(div?.className).toContain('w-full');
    });

    it('should have all three default classes', () => {
      const { container } = render(
        <ContentContainer>
          <p>Content</p>
        </ContentContainer>
      );
      const div = container.querySelector('div');
      expect(div?.className).toContain('mx-auto');
      expect(div?.className).toContain('px-4');
      expect(div?.className).toContain('w-full');
    });
  });

  describe('Custom ClassName', () => {
    it('should accept custom className', () => {
      const { container } = render(
        <ContentContainer className="custom-class">
          <p>Content</p>
        </ContentContainer>
      );
      const div = container.querySelector('div');
      expect(div?.className).toContain('custom-class');
    });

    it('should combine custom className with default classes', () => {
      const { container } = render(
        <ContentContainer className="py-4">
          <p>Content</p>
        </ContentContainer>
      );
      const div = container.querySelector('div');
      expect(div?.className).toContain('mx-auto');
      expect(div?.className).toContain('px-4');
      expect(div?.className).toContain('w-full');
      expect(div?.className).toContain('py-4');
    });

    it('should accept multiple custom classes', () => {
      const { container } = render(
        <ContentContainer className="py-4 bg-surface">
          <p>Content</p>
        </ContentContainer>
      );
      const div = container.querySelector('div');
      expect(div?.className).toContain('py-4');
      expect(div?.className).toContain('bg-surface');
    });

    it('should handle empty className', () => {
      const { container } = render(
        <ContentContainer className="">
          <p>Content</p>
        </ContentContainer>
      );
      const div = container.querySelector('div');
      expect(div?.className).toContain('mx-auto');
      expect(div?.className).toContain('px-4');
    });

    it('should handle undefined className', () => {
      const { container } = render(
        <ContentContainer>
          <p>Content</p>
        </ContentContainer>
      );
      const div = container.querySelector('div');
      expect(div?.className).toBe('mx-auto px-4 w-full');
    });
  });

  describe('Structure', () => {
    it('should render a div element', () => {
      const { container } = render(
        <ContentContainer>
          <p>Content</p>
        </ContentContainer>
      );
      const contentContainer = container.firstChild;
      expect(contentContainer?.nodeName.toLowerCase()).toBe('div');
    });

    it('should wrap children in single div', () => {
      const { container } = render(
        <ContentContainer>
          <p>First</p>
          <p>Second</p>
        </ContentContainer>
      );
      const divs = container.querySelectorAll('div');
      expect(divs.length).toBe(1);
    });
  });

  describe('Use Cases', () => {
    it('should work for message content', () => {
      const { container } = render(
        <ContentContainer className="py-4">
          <div class="message">Hello World</div>
        </ContentContainer>
      );
      const message = container.querySelector('.message');
      expect(message).toBeTruthy();
    });

    it('should work for input areas', () => {
      const { container } = render(
        <ContentContainer className="py-2">
          <input type="text" placeholder="Type here" />
        </ContentContainer>
      );
      const input = container.querySelector('input');
      expect(input).toBeTruthy();
    });

    it('should work for status bar', () => {
      const { container } = render(
        <ContentContainer className="py-1">
          <span class="status">Ready</span>
        </ContentContainer>
      );
      const status = container.querySelector('.status');
      expect(status?.textContent).toBe('Ready');
    });

    it('should expand width appropriately', () => {
      const { container } = render(
        <ContentContainer>
          <div class="wide-content" style={{ width: '2000px' }}>
            Wide content
          </div>
        </ContentContainer>
      );
      const wrapper = container.querySelector('div');
      expect(wrapper?.className).toContain('w-full');
    });
  });

  describe('Edge Cases', () => {
    it('should handle null children', () => {
      const { container } = render(<ContentContainer>{null}</ContentContainer>);
      const div = container.querySelector('div');
      expect(div).toBeTruthy();
      expect(div?.children.length).toBe(0);
    });

    it('should handle undefined children', () => {
      const { container } = render(<ContentContainer>{undefined}</ContentContainer>);
      const div = container.querySelector('div');
      expect(div).toBeTruthy();
    });

    it('should handle conditional children', () => {
      const showContent = true;
      const { container } = render(
        <ContentContainer>{showContent && <p>Conditional</p>}</ContentContainer>
      );
      const content = container.querySelector('p');
      expect(content?.textContent).toBe('Conditional');
    });

    it('should handle false conditional children', () => {
      const showContent = false;
      const { container } = render(
        <ContentContainer>{showContent && <p>Hidden</p>}</ContentContainer>
      );
      const content = container.querySelector('p');
      expect(content).toBeNull();
    });

    it('should handle array children', () => {
      const items = ['One', 'Two', 'Three'];
      const { container } = render(
        <ContentContainer>
          {items.map((item, i) => (
            <span key={i}>{item}</span>
          ))}
        </ContentContainer>
      );
      const spans = container.querySelectorAll('span');
      expect(spans.length).toBe(3);
    });
  });

  describe('Class Combination', () => {
    it('should place base classes before custom classes', () => {
      const { container } = render(
        <ContentContainer className="custom">
          <p>Content</p>
        </ContentContainer>
      );
      const div = container.querySelector('div');
      const classes = div?.className.split(' ');
      expect(classes?.indexOf('mx-auto')).toBeLessThan(classes?.indexOf('custom') || 999);
      expect(classes?.indexOf('px-4')).toBeLessThan(classes?.indexOf('custom') || 999);
      expect(classes?.indexOf('w-full')).toBeLessThan(classes?.indexOf('custom') || 999);
    });

    it('should preserve class order for specificity', () => {
      const { container } = render(
        <ContentContainer className="px-8">
          <p>Content</p>
        </ContentContainer>
      );
      const div = container.querySelector('div');
      expect(div?.className).toContain('px-4');
      expect(div?.className).toContain('px-8');
    });
  });
});
