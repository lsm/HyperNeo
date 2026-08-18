// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';

import { render, fireEvent, cleanup } from '@testing-library/preact';
import { ScrollToBottomButton } from '../ScrollToBottomButton';

describe('ScrollToBottomButton', () => {
  const mockOnClick = vi.fn(() => {});

  beforeEach(() => {
    cleanup();
    mockOnClick.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
    it('should render the button', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const button = container.querySelector('button');
      expect(button).toBeTruthy();
    });

    it('should render SVG icon', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should have down arrow path in SVG', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const path = container.querySelector('svg path');
      expect(path).toBeTruthy();
      expect(path?.getAttribute('d')).toContain('M19 9l-7 7-7-7');
    });
  });

  describe('Accessibility', () => {
    it('should have title attribute', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const button = container.querySelector('button[title="Scroll to bottom"]');
      expect(button).toBeTruthy();
    });

    it('should have aria-label attribute', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const button = container.querySelector('button[aria-label="Scroll to bottom"]');
      expect(button).toBeTruthy();
    });

    it('should have focus-visible ring styles', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const button = container.querySelector('button')!;
      expect(button.className).toContain('focus-visible:outline-none');
      expect(button.className).toContain('focus-visible:ring-2');
      expect(button.className).toContain('focus-visible:ring-blue-500');
    });
  });

  describe('Click Handling', () => {
    it('should call onClick when button is clicked', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(mockOnClick).toHaveBeenCalledTimes(1);
    });

    it('should call onClick multiple times on multiple clicks', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);

      expect(mockOnClick).toHaveBeenCalledTimes(3);
    });
  });

  describe('Styling', () => {
    it('should have floating button positioning', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const wrapper = container.firstElementChild!;
      expect(wrapper.className).toContain('absolute');
      expect(wrapper.className).toContain('bottom-36');
      expect(wrapper.className).toContain('left-1/2');
      expect(wrapper.className).toContain('-translate-x-1/2');
      expect(wrapper.className).toContain('z-20');
    });

    it('should have rounded button styling', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const button = container.querySelector('button')!;
      expect(button.className).toContain('rounded-full');
      expect(button.className).toContain('w-10');
      expect(button.className).toContain('h-10');
    });

    it('should have hover effects', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const button = container.querySelector('button')!;
      expect(button.className).toContain('hover:bg-dark-700');
      expect(button.className).toContain('hover:text-gray-100');
    });

    it('should have animation class', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const wrapper = container.querySelector('button')?.parentElement!;
      expect(wrapper.className).toContain('animate-slideIn');
    });

    it('should have shadow styling', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const button = container.querySelector('button')!;
      expect(button.className).toContain('shadow-lg');
    });

    it('should have flex centering for icon', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const button = container.querySelector('button')!;
      expect(button.className).toContain('flex');
      expect(button.className).toContain('items-center');
      expect(button.className).toContain('justify-center');
    });

    it('should have transition effects', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const button = container.querySelector('button')!;
      expect(button.className).toContain('transition-all');
      expect(button.className).toContain('duration-150');
    });
  });

  describe('Icon Styling', () => {
    it('should have properly sized icon', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const svg = container.querySelector('svg')!;
      expect(svg.className.baseVal || svg.getAttribute('class')).toContain('w-5');
      expect(svg.className.baseVal || svg.getAttribute('class')).toContain('h-5');
    });

    it('should have stroke width on icon', () => {
      const { container } = render(<ScrollToBottomButton onClick={mockOnClick} />);

      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('stroke-width')).toBe('2');
    });
  });
});
