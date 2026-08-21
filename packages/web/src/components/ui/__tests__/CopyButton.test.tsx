// @ts-nocheck

import { render, cleanup, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CopyButton } from '../CopyButton';

vi.mock('../../../lib/utils.ts', () => ({
  copyToClipboard: vi.fn(),
}));

vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { copyToClipboard } from '../../../lib/utils.ts';
import { toast } from '../../../lib/toast.ts';

describe('CopyButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Rendering', () => {
    it('should render a button', () => {
      render(<CopyButton text="test text" />);
      const button = document.body.querySelector('button');
      expect(button).toBeTruthy();
    });

    it('should render clipboard icon by default', () => {
      render(<CopyButton text="test text" />);
      const svg = document.body.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg?.classList.contains('w-4')).toBe(true);
      expect(svg?.classList.contains('h-4')).toBe(true);
    });

    it('should have correct title from label prop', () => {
      render(<CopyButton text="test text" label="Copy session ID" />);
      const button = document.body.querySelector('button');
      expect(button?.getAttribute('title')).toBe('Copy session ID');
    });

    it('should use default label when not provided', () => {
      render(<CopyButton text="test text" />);
      const button = document.body.querySelector('button');
      expect(button?.getAttribute('title')).toBe('Copy to clipboard');
    });
  });

  describe('Copy Functionality', () => {
    it('should call copyToClipboard when clicked', async () => {
      (copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      render(<CopyButton text="test text" />);
      const button = document.body.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await waitFor(() => {
        expect(copyToClipboard).toHaveBeenCalledWith('test text');
      });
    });

    it('should show success state on successful copy', async () => {
      (copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      render(<CopyButton text="test text" />);
      const button = document.body.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await waitFor(() => {
        expect(button?.getAttribute('title')).toBe('Copied!');
      });
    });

    it('should show custom label', async () => {
      (copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      render(<CopyButton text="test text" label="Copy SDK ID" />);
      const button = document.body.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await waitFor(() => {
        expect(button?.getAttribute('title')).toBe('Copied!');
      });
    });

    it('should not change state on failed copy', async () => {
      (copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      render(<CopyButton text="test text" />);
      const button = document.body.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(button?.getAttribute('title')).toBe('Copy to clipboard');
    });

    it('should show checkmark icon after successful copy', async () => {
      (copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      render(<CopyButton text="test text" />);
      const button = document.body.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await waitFor(() => {
        const button = document.body.querySelector('button');
        expect(button?.classList.contains('text-green-400')).toBe(true);
      });
    });

    it('should reset copied state after 2 seconds', async () => {
      vi.useFakeTimers();
      (copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      render(<CopyButton text="test text" />);
      const button = document.body.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      let btn = document.body.querySelector('button');
      expect(btn?.classList.contains('text-green-400')).toBe(true);

      await vi.advanceTimersByTimeAsync(2000);

      btn = document.body.querySelector('button');
      expect(btn?.classList.contains('text-green-400')).toBe(false);

      vi.useRealTimers();
    });

    it('should reset copied state when text changes', async () => {
      vi.useFakeTimers();
      (copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const { rerender } = render(<CopyButton text="first" />);
      const button = document.body.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(button?.classList.contains('text-green-400')).toBe(true);

      rerender(<CopyButton text="second" />);

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(button?.classList.contains('text-green-400')).toBe(false);
      expect(button?.getAttribute('title')).toBe('Copy to clipboard');

      vi.useRealTimers();
    });

    it('should ignore stale copy completions after text changes', async () => {
      let resolveCopy: (value: boolean) => void = () => {};
      (copyToClipboard as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveCopy = resolve;
          })
      );

      const { rerender } = render(<CopyButton text="first" />);
      const button = document.body.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      rerender(<CopyButton text="second" />);

      resolveCopy(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(button?.classList.contains('text-green-400')).toBe(false);
      expect(button?.getAttribute('title')).toBe('Copy to clipboard');
    });
  });

  describe('Styling', () => {
    it('should have proper button styling', () => {
      render(<CopyButton text="test text" />);
      const button = document.body.querySelector('button');
      expect(button?.className).toContain('p-1.5');
      expect(button?.className).toContain('text-gray-400');
      expect(button?.className).toContain('hover:text-gray-200');
      expect(button?.className).toContain('rounded');
    });

    it('should have button type attribute', () => {
      render(<CopyButton text="test text" />);
      const button = document.body.querySelector('button');
      expect(button?.getAttribute('type')).toBe('button');
    });
  });
});
