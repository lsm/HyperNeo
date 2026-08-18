// @ts-nocheck

import { render, cleanup } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';
import { ToastItem } from '../Toast';
import type { Toast } from '../../../lib/toast';

const mockDismissToast = vi.fn(() => {});

const originalModule = await import('../../../lib/toast');
const _mockToastModule = {
  ...originalModule,
  dismissToast: mockDismissToast,
};

describe('ToastItem', () => {
  beforeEach(() => {
    mockDismissToast.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  const createToast = (overrides: Partial<Toast> = {}): Toast => ({
    id: 'test-toast-1',
    type: 'info',
    message: 'Test message',
    duration: 5000,
    ...overrides,
  });

  describe('Rendering', () => {
    it('should render toast message', () => {
      const toast = createToast({ message: 'Hello World' });
      const { container } = render(<ToastItem toast={toast} />);
      expect(container.textContent).toContain('Hello World');
    });

    it('should render dismiss button', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const dismissButton = container.querySelector('button[aria-label="Dismiss notification"]');
      expect(dismissButton).toBeTruthy();
    });

    it('should have role="alert"', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const alert = container.querySelector('[role="alert"]');
      expect(alert).toBeTruthy();
    });
  });

  describe('Toast Types', () => {
    describe('Success', () => {
      it('should render success icon', () => {
        const toast = createToast({ type: 'success' });
        const { container } = render(<ToastItem toast={toast} />);
        const svg = container.querySelector('svg');
        expect(svg).toBeTruthy();
      });

      it('should have success styling', () => {
        const toast = createToast({ type: 'success' });
        const { container } = render(<ToastItem toast={toast} />);
        const alert = container.querySelector('[role="alert"]');
        expect(alert?.className).toContain('text-green-400');
      });

      it('should have green background', () => {
        const toast = createToast({ type: 'success' });
        const { container } = render(<ToastItem toast={toast} />);
        const alert = container.querySelector('[role="alert"]');
        expect(alert?.className).toContain('bg-green-500/10');
      });
    });

    describe('Error', () => {
      it('should render error icon', () => {
        const toast = createToast({ type: 'error' });
        const { container } = render(<ToastItem toast={toast} />);
        const svg = container.querySelector('svg');
        expect(svg).toBeTruthy();
      });

      it('should have error styling', () => {
        const toast = createToast({ type: 'error' });
        const { container } = render(<ToastItem toast={toast} />);
        const alert = container.querySelector('[role="alert"]');
        expect(alert?.className).toContain('text-red-400');
      });

      it('should have red background', () => {
        const toast = createToast({ type: 'error' });
        const { container } = render(<ToastItem toast={toast} />);
        const alert = container.querySelector('[role="alert"]');
        expect(alert?.className).toContain('bg-red-500/10');
      });
    });

    describe('Warning', () => {
      it('should render warning icon', () => {
        const toast = createToast({ type: 'warning' });
        const { container } = render(<ToastItem toast={toast} />);
        const svg = container.querySelector('svg');
        expect(svg).toBeTruthy();
      });

      it('should have warning styling', () => {
        const toast = createToast({ type: 'warning' });
        const { container } = render(<ToastItem toast={toast} />);
        const alert = container.querySelector('[role="alert"]');
        expect(alert?.className).toContain('text-yellow-400');
      });

      it('should have yellow background', () => {
        const toast = createToast({ type: 'warning' });
        const { container } = render(<ToastItem toast={toast} />);
        const alert = container.querySelector('[role="alert"]');
        expect(alert?.className).toContain('bg-yellow-500/10');
      });
    });

    describe('Info', () => {
      it('should render info icon', () => {
        const toast = createToast({ type: 'info' });
        const { container } = render(<ToastItem toast={toast} />);
        const svg = container.querySelector('svg');
        expect(svg).toBeTruthy();
      });

      it('should have info styling', () => {
        const toast = createToast({ type: 'info' });
        const { container } = render(<ToastItem toast={toast} />);
        const alert = container.querySelector('[role="alert"]');
        expect(alert?.className).toContain('text-blue-400');
      });

      it('should have blue background', () => {
        const toast = createToast({ type: 'info' });
        const { container } = render(<ToastItem toast={toast} />);
        const alert = container.querySelector('[role="alert"]');
        expect(alert?.className).toContain('bg-blue-500/10');
      });
    });
  });

  describe('Progress Bar', () => {
    it('should render progress bar when duration is set', () => {
      const toast = createToast({ duration: 5000 });
      const { container } = render(<ToastItem toast={toast} />);
      const progressContainer = container.querySelector('.bg-white\\/10');
      expect(progressContainer).toBeTruthy();
    });

    it('should not render progress bar when duration is 0', () => {
      const toast = createToast({ duration: 0 });
      const { container } = render(<ToastItem toast={toast} />);
      const progressContainer = container.querySelector('.bg-white\\/10');
      expect(progressContainer).toBeNull();
    });

    it('should not render progress bar when duration is undefined', () => {
      const toast = createToast({ duration: undefined });
      const { container } = render(<ToastItem toast={toast} />);
      const progressContainer = container.querySelector('.bg-white\\/10');
      expect(progressContainer).toBeNull();
    });

    it('should have success color progress bar for success type', () => {
      const toast = createToast({ type: 'success', duration: 5000 });
      const { container } = render(<ToastItem toast={toast} />);
      const progressBar = container.querySelector('.bg-green-500');
      expect(progressBar).toBeTruthy();
    });

    it('should have error color progress bar for error type', () => {
      const toast = createToast({ type: 'error', duration: 5000 });
      const { container } = render(<ToastItem toast={toast} />);
      const progressBar = container.querySelector('.bg-red-500');
      expect(progressBar).toBeTruthy();
    });

    it('should have warning color progress bar for warning type', () => {
      const toast = createToast({ type: 'warning', duration: 5000 });
      const { container } = render(<ToastItem toast={toast} />);
      const progressBar = container.querySelector('.bg-yellow-500');
      expect(progressBar).toBeTruthy();
    });

    it('should have info color progress bar for info type', () => {
      const toast = createToast({ type: 'info', duration: 5000 });
      const { container } = render(<ToastItem toast={toast} />);
      const progressBar = container.querySelector('.bg-blue-500');
      expect(progressBar).toBeTruthy();
    });

    it('should start progress at 100%', () => {
      const toast = createToast({ duration: 5000 });
      const { container } = render(<ToastItem toast={toast} />);
      const progressBar = container.querySelector('.bg-blue-500') as HTMLElement;
      expect(progressBar?.style.width).toBe('100%');
    });

    it('should decrease progress over time', async () => {
      const toast = createToast({ duration: 500 });
      const { container } = render(<ToastItem toast={toast} />);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const progressBar = container.querySelector('.bg-blue-500') as HTMLElement;
      const width = parseFloat(progressBar?.style.width || '100');
      expect(width).toBeLessThan(100);
    });

    it('should complete progress and reach 0%', async () => {
      const toast = createToast({ duration: 200 });
      const { container } = render(<ToastItem toast={toast} />);

      await new Promise((resolve) => setTimeout(resolve, 300));

      const progressBar = container.querySelector('.bg-blue-500') as HTMLElement;
      const width = parseFloat(progressBar?.style.width || '100');
      expect(width).toBe(0);
    });
  });

  describe('Dismiss behavior', () => {
    it('should trigger exit animation on dismiss click', async () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);

      const dismissButton = container.querySelector('button[aria-label="Dismiss notification"]');
      dismissButton?.click();

      await new Promise((resolve) => setTimeout(resolve, 50));

      const alert = container.querySelector('[role="alert"]');
      expect(alert?.className).toContain('opacity-0');
      expect(alert?.className).toContain('translate-x-full');
    });

    it('should not have exit animation initially', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);

      const alert = container.querySelector('[role="alert"]');
      expect(alert?.className).not.toContain('opacity-0');
    });
  });

  describe('Dismiss Button', () => {
    it('should have aria-label for accessibility', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const dismissButton = container.querySelector('button[aria-label="Dismiss notification"]');
      expect(dismissButton).toBeTruthy();
    });

    it('should have dismiss icon', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const dismissButton = container.querySelector('button[aria-label="Dismiss notification"]');
      const svg = dismissButton?.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should have hover styles', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const dismissButton = container.querySelector('button[aria-label="Dismiss notification"]');
      expect(dismissButton?.className).toContain('hover:text-gray-100');
    });
  });

  describe('Icons', () => {
    it('should render icon container', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const iconContainer = container.querySelector('.flex-shrink-0');
      expect(iconContainer).toBeTruthy();
    });

    it('should render SVG icon with correct size', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const iconContainer = container.querySelector('.flex-shrink-0');
      const svg = iconContainer?.querySelector('svg');
      const svgClass = svg?.getAttribute('class') || '';
      expect(svgClass).toContain('w-5');
      expect(svgClass).toContain('h-5');
    });
  });

  describe('Styling', () => {
    it('should have flex layout', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.className).toContain('flex');
    });

    it('should have rounded corners', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.className).toContain('rounded-lg');
    });

    it('should have border', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.className).toContain('border');
    });

    it('should have shadow', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.className).toContain('shadow-lg');
    });

    it('should have backdrop blur', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.className).toContain('backdrop-blur-sm');
    });

    it('should have padding', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.className).toContain('p-4');
    });

    it('should have gap between items', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.className).toContain('gap-3');
    });
  });

  describe('Animation', () => {
    it('should have slide in animation initially', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.className).toContain('animate-slideInRight');
    });

    it('should have transition classes', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.className).toContain('transition-all');
    });

    it('should have opacity-100 initially', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.className).toContain('opacity-100');
    });
  });

  describe('Message Display', () => {
    it('should display message text', () => {
      const toast = createToast({ message: 'Operation successful!' });
      const { container } = render(<ToastItem toast={toast} />);
      expect(container.textContent).toContain('Operation successful!');
    });

    it('should have message styling', () => {
      const toast = createToast();
      const { container } = render(<ToastItem toast={toast} />);
      const messageDiv = container.querySelector('.flex-1');
      expect(messageDiv?.className).toContain('text-sm');
      expect(messageDiv?.className).toContain('text-gray-100');
    });

    it('should handle long messages', () => {
      const longMessage =
        'This is a very long message that should still be displayed correctly in the toast notification component.';
      const toast = createToast({ message: longMessage });
      const { container } = render(<ToastItem toast={toast} />);
      expect(container.textContent).toContain(longMessage);
    });
  });

  describe('Overflow', () => {
    it('should hide overflow for progress bar', () => {
      const toast = createToast({ duration: 5000 });
      const { container } = render(<ToastItem toast={toast} />);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.className).toContain('overflow-hidden');
    });
  });

  describe('Multiple Toasts', () => {
    it('should render different types correctly', () => {
      const successToast = createToast({ id: '1', type: 'success' });
      const errorToast = createToast({ id: '2', type: 'error' });

      const { container: c1 } = render(<ToastItem toast={successToast} />);
      const { container: c2 } = render(<ToastItem toast={errorToast} />);

      const successAlert = c1.querySelector('[role="alert"]');
      const errorAlert = c2.querySelector('[role="alert"]');

      expect(successAlert?.className).toContain('text-green-400');
      expect(errorAlert?.className).toContain('text-red-400');
    });
  });
});
