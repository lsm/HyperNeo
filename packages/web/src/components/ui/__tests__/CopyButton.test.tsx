// @ts-nocheck
/**
 * Tests for CopyButton Component
 */

import { render, cleanup, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CopyButton } from '../CopyButton';

// Mock copyToClipboard
vi.mock('../../../lib/utils.ts', () => ({
  copyToClipboard: vi.fn(),
}));

// Mock toast
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
        // On success, button shows checkmark and title changes to "Copied!"
        expect(button?.getAttribute('title')).toBe('Copied!');
      });
    });

    it('should show custom label', async () => {
      (copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      render(<CopyButton text="test text" label="Copy SDK ID" />);
      const button = document.body.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await waitFor(() => {
        // On success, title changes from custom label to "Copied!"
        expect(button?.getAttribute('title')).toBe('Copied!');
      });
    });

    it('should not change state on failed copy', async () => {
      (copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      render(<CopyButton text="test text" />);
      const button = document.body.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      // On failure, title should remain as default label
      expect(button?.getAttribute('title')).toBe('Copy to clipboard');
    });

    it('should show checkmark icon after successful copy', async () => {
      (copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      render(<CopyButton text="test text" />);
      const button = document.body.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await waitFor(() => {
        const button = document.body.querySelector('button');
        // Check for green color class indicating checkmark (class is on button, not svg)
        expect(button?.classList.contains('text-green-400')).toBe(true);
      });
    });

    it('should reset copied state after 2 seconds', async () => {
      vi.useFakeTimers();
      (copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      render(<CopyButton text="test text" />);
      const button = document.body.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      // Allow promises to resolve (for the async copyToClipboard)
      await Promise.resolve();
      // Flush microtask queue for state update
      await vi.advanceTimersByTimeAsync(0);

      // Initially should show checkmark (green - class is on button, not svg)
      let btn = document.body.querySelector('button');
      expect(btn?.classList.contains('text-green-400')).toBe(true);

      // Advance time by 2 seconds
      await vi.advanceTimersByTimeAsync(2000);

      // Should revert to clipboard icon (no green class)
      btn = document.body.querySelector('button');
      expect(btn?.classList.contains('text-green-400')).toBe(false);

      vi.useRealTimers();
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
