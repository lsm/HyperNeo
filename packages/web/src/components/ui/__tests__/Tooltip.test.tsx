// @ts-nocheck

import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/preact';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Tooltip } from '../Tooltip';

describe('Tooltip', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    cleanup();
  });

  describe('Rendering', () => {
    it('should render children', () => {
      const { container } = render(
        <Tooltip content="Tooltip text">
          <button>Hover me</button>
        </Tooltip>
      );
      const button = container.querySelector('button');
      expect(button?.textContent).toBe('Hover me');
    });

    it('should not show tooltip content by default', () => {
      const { container } = render(
        <Tooltip content="Tooltip text">
          <button>Hover me</button>
        </Tooltip>
      );
      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).toBeNull();
    });

    it('should wrap children in relative container', () => {
      const { container } = render(
        <Tooltip content="Tooltip text">
          <button>Hover me</button>
        </Tooltip>
      );
      const wrapper = container.querySelector('.relative');
      expect(wrapper).toBeTruthy();
    });

    it('should be inline-block element', () => {
      const { container } = render(
        <Tooltip content="Tooltip text">
          <button>Hover me</button>
        </Tooltip>
      );
      const wrapper = container.querySelector('.inline-block');
      expect(wrapper).toBeTruthy();
    });
  });

  describe('Positions', () => {
    it('should position tooltip on top by default', async () => {
      const { container } = render(
        <Tooltip content="Top tooltip" delay={0}>
          <button>Hover me</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.className).toContain('bottom-full');
      });
    });

    it('should position tooltip on bottom', async () => {
      const { container } = render(
        <Tooltip content="Bottom tooltip" position="bottom" delay={0}>
          <button>Hover me</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.className).toContain('top-full');
      });
    });

    it('should position tooltip on left', async () => {
      const { container } = render(
        <Tooltip content="Left tooltip" position="left" delay={0}>
          <button>Hover me</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.className).toContain('right-full');
      });
    });

    it('should position tooltip on right', async () => {
      const { container } = render(
        <Tooltip content="Right tooltip" position="right" delay={0}>
          <button>Hover me</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.className).toContain('left-full');
      });
    });
  });

  describe('Delay Functionality', () => {
    it('should default to 500ms delay', async () => {
      const { container } = render(
        <Tooltip content="Delayed tooltip">
          <button>Hover me</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      let tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 600));

      tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).toBeTruthy();
    });

    it('should respect custom delay', async () => {
      const { container } = render(
        <Tooltip content="Quick tooltip" delay={100}>
          <button>Hover me</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      let tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 150));

      tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).toBeTruthy();
    });

    it('should show immediately with zero delay', async () => {
      const { container } = render(
        <Tooltip content="Instant tooltip" delay={0}>
          <button>Hover me</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).toBeTruthy();
    });
  });

  describe('Mouse Interactions', () => {
    it('should show tooltip on mouse enter', async () => {
      const { container } = render(
        <Tooltip content="Hover tooltip" delay={0}>
          <button>Hover me</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip).toBeTruthy();
      });
    });

    it('should hide tooltip on mouse leave', async () => {
      const { container } = render(
        <Tooltip content="Hide tooltip" delay={0}>
          <button>Hover me</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip).toBeTruthy();
      });

      fireEvent.mouseLeave(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip).toBeNull();
      });
    });

    it('should cancel tooltip if mouse leaves before delay', async () => {
      const { container } = render(
        <Tooltip content="Cancelled tooltip" delay={200}>
          <button>Hover me</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await new Promise((resolve) => setTimeout(resolve, 50));
      fireEvent.mouseLeave(wrapper!);

      await new Promise((resolve) => setTimeout(resolve, 300));

      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).toBeNull();
    });
  });

  describe('Content', () => {
    it('should display tooltip content text', async () => {
      const { container } = render(
        <Tooltip content="Test content" delay={0}>
          <button>Hover me</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.textContent).toContain('Test content');
      });
    });

    it('should handle long content with whitespace-nowrap', async () => {
      const { container } = render(
        <Tooltip content="This is a longer tooltip text" delay={0}>
          <button>Hover</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.className).toContain('whitespace-nowrap');
      });
    });
  });

  describe('Styling', () => {
    it('should have z-index for stacking', async () => {
      const { container } = render(
        <Tooltip content="Stacked tooltip" delay={0}>
          <button>Hover</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.classList.contains('z-50')).toBe(true);
      });
    });

    it('should have shadow styling', async () => {
      const { container } = render(
        <Tooltip content="Shadowed tooltip" delay={0}>
          <button>Hover</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.classList.contains('shadow-lg')).toBe(true);
      });
    });

    it('should have rounded corners', async () => {
      const { container } = render(
        <Tooltip content="Rounded tooltip" delay={0}>
          <button>Hover</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.classList.contains('rounded-md')).toBe(true);
      });
    });

    it('should have fade-in animation', async () => {
      const { container } = render(
        <Tooltip content="Animated tooltip" delay={0}>
          <button>Hover</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.classList.contains('animate-fadeIn')).toBe(true);
      });
    });

    it('should be pointer-events-none', async () => {
      const { container } = render(
        <Tooltip content="Non-interactive tooltip" delay={0}>
          <button>Hover</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.classList.contains('pointer-events-none')).toBe(true);
      });
    });

    it('should have dark background', async () => {
      const { container } = render(
        <Tooltip content="Dark tooltip" delay={0}>
          <button>Hover</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.classList.contains('bg-surface-raised')).toBe(true);
      });
    });
  });

  describe('Accessibility', () => {
    it('should have role="tooltip"', async () => {
      const { container } = render(
        <Tooltip content="Accessible tooltip" delay={0}>
          <button>Hover</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip).toBeTruthy();
      });
    });

    it('should have white text for contrast', async () => {
      const { container } = render(
        <Tooltip content="Contrasted tooltip" delay={0}>
          <button>Hover</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.classList.contains('text-fg')).toBe(true);
      });
    });

    it('should have small text size', async () => {
      const { container } = render(
        <Tooltip content="Small text tooltip" delay={0}>
          <button>Hover</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        expect(tooltip?.classList.contains('text-xs')).toBe(true);
      });
    });
  });

  describe('Arrow', () => {
    it('should render arrow element', async () => {
      const { container } = render(
        <Tooltip content="Arrow tooltip" delay={0}>
          <button>Hover</button>
        </Tooltip>
      );

      const wrapper = container.querySelector('.relative');
      fireEvent.mouseEnter(wrapper!);

      await waitFor(() => {
        const tooltip = screen.queryByRole('tooltip');
        const arrow = tooltip?.querySelector('.border-t-surface-raised');
        expect(arrow).toBeTruthy();
      });
    });
  });
});
