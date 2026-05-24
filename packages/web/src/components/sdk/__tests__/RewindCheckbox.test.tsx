/**
 * RewindCheckbox Function Tests
 *
 * Tests the shared renderRewindCheckbox function with all possible input combinations
 * to achieve 100% coverage of the guard clauses and checkbox rendering logic.
 */

import { fireEvent, render } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { type RewindCheckboxParams, renderRewindCheckbox } from '../RewindCheckbox';

describe('renderRewindCheckbox', () => {
  describe('Returns null when conditions are not met', () => {
    it('should return null when rewindMode is false', () => {
      const params: RewindCheckboxParams = {
        rewindMode: false,
        messageUuid: 'test-uuid',
        onMessageCheckboxChange: vi.fn(),
        selectedMessages: new Set(),
      };

      const result = renderRewindCheckbox(params);
      expect(result).toBeNull();
    });

    it('should return null when messageUuid is undefined', () => {
      const params: RewindCheckboxParams = {
        rewindMode: true,
        messageUuid: undefined,
        onMessageCheckboxChange: vi.fn(),
        selectedMessages: new Set(),
      };

      const result = renderRewindCheckbox(params);
      expect(result).toBeNull();
    });

    it('should return null when onMessageCheckboxChange is undefined', () => {
      const params: RewindCheckboxParams = {
        rewindMode: true,
        messageUuid: 'test-uuid',
        onMessageCheckboxChange: undefined,
        selectedMessages: new Set(),
      };

      const result = renderRewindCheckbox(params);
      expect(result).toBeNull();
    });

    it('should return null when hasSubagentChild is true', () => {
      const params: RewindCheckboxParams = {
        rewindMode: true,
        messageUuid: 'test-uuid',
        onMessageCheckboxChange: vi.fn(),
        selectedMessages: new Set(),
        hasSubagentChild: true,
      };

      const result = renderRewindCheckbox(params);
      expect(result).toBeNull();
    });

    it('should return null when multiple conditions are false', () => {
      const params: RewindCheckboxParams = {
        rewindMode: false,
        messageUuid: undefined,
        onMessageCheckboxChange: undefined,
        selectedMessages: new Set(),
      };

      const result = renderRewindCheckbox(params);
      expect(result).toBeNull();
    });
  });

  describe('Returns checkbox JSX when all conditions are met', () => {
    it('should return checkbox element when all required params are valid', () => {
      const params: RewindCheckboxParams = {
        rewindMode: true,
        messageUuid: 'test-uuid',
        onMessageCheckboxChange: vi.fn(),
        selectedMessages: new Set(),
      };

      const result = renderRewindCheckbox(params);
      expect(result).not.toBeNull();

      // Render the result to verify it's valid JSX
      if (result) {
        const { container } = render(result);
        const checkbox = container.querySelector('input[type="checkbox"]');
        expect(checkbox).toBeTruthy();
      }
    });

    it('should render unchecked checkbox when message is not selected', () => {
      const params: RewindCheckboxParams = {
        rewindMode: true,
        messageUuid: 'test-uuid',
        onMessageCheckboxChange: vi.fn(),
        selectedMessages: new Set(['other-uuid']),
      };

      const result = renderRewindCheckbox(params);
      if (result) {
        const { container } = render(result);
        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox.checked).toBe(false);
      }
    });

    it('should render checked checkbox when message is selected', () => {
      const params: RewindCheckboxParams = {
        rewindMode: true,
        messageUuid: 'test-uuid',
        onMessageCheckboxChange: vi.fn(),
        selectedMessages: new Set(['test-uuid']),
      };

      const result = renderRewindCheckbox(params);
      if (result) {
        const { container } = render(result);
        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox.checked).toBe(true);
      }
    });

    it('should call onMessageCheckboxChange when checkbox is clicked', () => {
      const onMessageCheckboxChange = vi.fn();
      const params: RewindCheckboxParams = {
        rewindMode: true,
        messageUuid: 'test-uuid',
        onMessageCheckboxChange,
        selectedMessages: new Set(),
      };

      const result = renderRewindCheckbox(params);
      if (result) {
        const { container } = render(result);
        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
        fireEvent.click(checkbox);
        expect(onMessageCheckboxChange).toHaveBeenCalledWith('test-uuid', true);
      }
    });

    it('should work without selectedMessages set (defaults to unchecked)', () => {
      const params: RewindCheckboxParams = {
        rewindMode: true,
        messageUuid: 'test-uuid',
        onMessageCheckboxChange: vi.fn(),
        selectedMessages: undefined,
      };

      const result = renderRewindCheckbox(params);
      if (result) {
        const { container } = render(result);
        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox.checked).toBe(false);
      }
    });

    it('should work when hasSubagentChild is false', () => {
      const params: RewindCheckboxParams = {
        rewindMode: true,
        messageUuid: 'test-uuid',
        onMessageCheckboxChange: vi.fn(),
        selectedMessages: new Set(),
        hasSubagentChild: false,
      };

      const result = renderRewindCheckbox(params);
      expect(result).not.toBeNull();
      if (result) {
        const { container } = render(result);
        const checkbox = container.querySelector('input[type="checkbox"]');
        expect(checkbox).toBeTruthy();
      }
    });

    it('should work when hasSubagentChild is undefined', () => {
      const params: RewindCheckboxParams = {
        rewindMode: true,
        messageUuid: 'test-uuid',
        onMessageCheckboxChange: vi.fn(),
        selectedMessages: new Set(),
        hasSubagentChild: undefined,
      };

      const result = renderRewindCheckbox(params);
      expect(result).not.toBeNull();
      if (result) {
        const { container } = render(result);
        const checkbox = container.querySelector('input[type="checkbox"]');
        expect(checkbox).toBeTruthy();
      }
    });
  });

  describe('Checkbox behavior', () => {
    it('should toggle from unchecked to checked', () => {
      const onMessageCheckboxChange = vi.fn();
      const params: RewindCheckboxParams = {
        rewindMode: true,
        messageUuid: 'test-uuid',
        onMessageCheckboxChange,
        selectedMessages: new Set(),
      };

      const result = renderRewindCheckbox(params);
      if (result) {
        const { container } = render(result);
        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox.checked).toBe(false);
        fireEvent.click(checkbox);
        expect(onMessageCheckboxChange).toHaveBeenCalledWith('test-uuid', true);
      }
    });

    it('should toggle from checked to unchecked', () => {
      const onMessageCheckboxChange = vi.fn();
      const params: RewindCheckboxParams = {
        rewindMode: true,
        messageUuid: 'test-uuid',
        onMessageCheckboxChange,
        selectedMessages: new Set(['test-uuid']),
      };

      const result = renderRewindCheckbox(params);
      if (result) {
        const { container } = render(result);
        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox.checked).toBe(true);
        fireEvent.click(checkbox);
        expect(onMessageCheckboxChange).toHaveBeenCalledWith('test-uuid', false);
      }
    });
  });
});
