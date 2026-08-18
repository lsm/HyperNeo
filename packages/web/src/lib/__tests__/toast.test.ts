// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { toast, dismissToast, toastsSignal } from '../toast';

describe('toast', () => {
  beforeEach(() => {
    toastsSignal.value = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    toastsSignal.value = [];
  });

  describe('toast.success', () => {
    it('should create a success toast', () => {
      const id = toast.success('Success message');

      expect(id).toBeTruthy();
      expect(id.startsWith('toast-')).toBe(true);
      expect(toastsSignal.value).toHaveLength(1);
      expect(toastsSignal.value[0].type).toBe('success');
      expect(toastsSignal.value[0].message).toBe('Success message');
    });

    it('should use default duration of 5000ms', () => {
      toast.success('Success message');

      expect(toastsSignal.value[0].duration).toBe(5000);
    });

    it('should accept custom duration', () => {
      toast.success('Success message', 3000);

      expect(toastsSignal.value[0].duration).toBe(3000);
    });
  });

  describe('toast.error', () => {
    it('should create an error toast', () => {
      const id = toast.error('Error message');

      expect(id).toBeTruthy();
      expect(toastsSignal.value).toHaveLength(1);
      expect(toastsSignal.value[0].type).toBe('error');
      expect(toastsSignal.value[0].message).toBe('Error message');
    });

    it('should accept custom duration', () => {
      toast.error('Error message', 10000);

      expect(toastsSignal.value[0].duration).toBe(10000);
    });
  });

  describe('toast.info', () => {
    it('should create an info toast', () => {
      const id = toast.info('Info message');

      expect(id).toBeTruthy();
      expect(toastsSignal.value).toHaveLength(1);
      expect(toastsSignal.value[0].type).toBe('info');
      expect(toastsSignal.value[0].message).toBe('Info message');
    });
  });

  describe('toast.warning', () => {
    it('should create a warning toast', () => {
      const id = toast.warning('Warning message');

      expect(id).toBeTruthy();
      expect(toastsSignal.value).toHaveLength(1);
      expect(toastsSignal.value[0].type).toBe('warning');
      expect(toastsSignal.value[0].message).toBe('Warning message');
    });
  });

  describe('Auto-dismiss', () => {
    it('should auto-dismiss toast after duration', () => {
      toast.success('Test', 5000);

      expect(toastsSignal.value).toHaveLength(1);

      vi.advanceTimersByTime(5000);

      expect(toastsSignal.value).toHaveLength(0);
    });

    it('should not auto-dismiss when duration is 0', () => {
      toast.success('Persistent toast', 0);

      expect(toastsSignal.value).toHaveLength(1);

      vi.advanceTimersByTime(10000);

      expect(toastsSignal.value).toHaveLength(1);
    });

    it('should dismiss correct toast when multiple exist', () => {
      toast.success('First', 3000);
      toast.success('Second', 5000);

      expect(toastsSignal.value).toHaveLength(2);

      vi.advanceTimersByTime(3000);

      expect(toastsSignal.value).toHaveLength(1);
      expect(toastsSignal.value[0].message).toBe('Second');

      vi.advanceTimersByTime(2000);

      expect(toastsSignal.value).toHaveLength(0);
    });
  });

  describe('dismissToast', () => {
    it('should dismiss toast by id', () => {
      const id = toast.success('Test');

      expect(toastsSignal.value).toHaveLength(1);

      dismissToast(id);

      expect(toastsSignal.value).toHaveLength(0);
    });

    it('should do nothing when dismissing non-existent id', () => {
      toast.success('Test');

      expect(toastsSignal.value).toHaveLength(1);

      dismissToast('non-existent-id');

      expect(toastsSignal.value).toHaveLength(1);
    });

    it('should dismiss correct toast when multiple exist', () => {
      toast.success('First');
      const id2 = toast.error('Second');
      toast.info('Third');

      expect(toastsSignal.value).toHaveLength(3);

      dismissToast(id2);

      expect(toastsSignal.value).toHaveLength(2);
      expect(toastsSignal.value.find((t) => t.message === 'Second')).toBeUndefined();
      expect(toastsSignal.value.find((t) => t.message === 'First')).toBeTruthy();
      expect(toastsSignal.value.find((t) => t.message === 'Third')).toBeTruthy();
    });
  });

  describe('Toast ID Generation', () => {
    it('should generate unique IDs for each toast', () => {
      const id1 = toast.success('First');
      const id2 = toast.success('Second');
      const id3 = toast.success('Third');

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it('should have incrementing IDs', () => {
      const id1 = toast.success('First');
      const id2 = toast.success('Second');

      const num1 = parseInt(id1.replace('toast-', ''));
      const num2 = parseInt(id2.replace('toast-', ''));

      expect(num2).toBe(num1 + 1);
    });
  });

  describe('Multiple Toasts', () => {
    it('should allow multiple toasts at the same time', () => {
      toast.success('Success');
      toast.error('Error');
      toast.info('Info');
      toast.warning('Warning');

      expect(toastsSignal.value).toHaveLength(4);
      expect(toastsSignal.value[0].type).toBe('success');
      expect(toastsSignal.value[1].type).toBe('error');
      expect(toastsSignal.value[2].type).toBe('info');
      expect(toastsSignal.value[3].type).toBe('warning');
    });

    it('should maintain order when adding toasts', () => {
      toast.success('First');
      toast.success('Second');
      toast.success('Third');

      expect(toastsSignal.value[0].message).toBe('First');
      expect(toastsSignal.value[1].message).toBe('Second');
      expect(toastsSignal.value[2].message).toBe('Third');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty message', () => {
      const id = toast.success('');

      expect(id).toBeTruthy();
      expect(toastsSignal.value[0].message).toBe('');
    });

    it('should handle very long message', () => {
      const longMessage = 'a'.repeat(10000);
      const id = toast.success(longMessage);

      expect(id).toBeTruthy();
      expect(toastsSignal.value[0].message).toBe(longMessage);
    });

    it('should handle negative duration (treated as 0)', () => {
      toast.success('Test', -1000);

      vi.advanceTimersByTime(10000);

      expect(toastsSignal.value).toHaveLength(1);
    });
  });
});
