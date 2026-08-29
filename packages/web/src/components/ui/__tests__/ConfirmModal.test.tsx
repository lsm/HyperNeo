// @ts-nocheck

import { render, cleanup } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmModal } from '../ConfirmModal';

describe('ConfirmModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
  });

  describe('Rendering', () => {
    it('should render title', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Confirm Action"
          message="Are you sure?"
        />
      );
      const title = document.body.querySelector('h2');
      expect(title?.textContent).toBe('Confirm Action');
    });

    it('should render message', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="This is the confirmation message"
        />
      );
      const message = document.body.querySelector('p');
      expect(message?.textContent).toBe('This is the confirmation message');
    });

    it('should not render when closed', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={false}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const modal = document.body.querySelector('.bg-surface');
      expect(modal).toBeNull();
    });

    it('should render confirm and cancel buttons', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      expect(buttons.length).toBe(2);
    });

    it('should not show close button (X) in header', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const closeButton = document.body.querySelector('button[aria-label="Close modal"]');
      expect(closeButton).toBeNull();
    });
  });

  describe('Button Text', () => {
    it('should use default confirm text "Confirm"', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const confirmButton = Array.from(buttons).find((btn) => btn.textContent === 'Confirm');
      expect(confirmButton).toBeTruthy();
    });

    it('should use default cancel text "Cancel"', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const cancelButton = Array.from(buttons).find((btn) => btn.textContent === 'Cancel');
      expect(cancelButton).toBeTruthy();
    });

    it('should use custom confirm text', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
          confirmText="Delete"
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const confirmButton = Array.from(buttons).find((btn) => btn.textContent === 'Delete');
      expect(confirmButton).toBeTruthy();
    });

    it('should use custom cancel text', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
          cancelText="Dismiss"
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const cancelButton = Array.from(buttons).find((btn) => btn.textContent === 'Dismiss');
      expect(cancelButton).toBeTruthy();
    });
  });

  describe('Button Variants', () => {
    it('should use danger variant by default for confirm button', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const confirmButton = Array.from(buttons).find((btn) => btn.textContent === 'Confirm');
      expect(confirmButton?.className).toContain('bg-danger');
    });

    it('should support danger variant explicitly', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
          confirmButtonVariant="danger"
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const confirmButton = Array.from(buttons).find((btn) => btn.textContent === 'Confirm');
      expect(confirmButton?.className).toContain('bg-danger');
      expect(confirmButton?.className).toContain('hover:bg-danger');
    });

    it('should support primary variant', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
          confirmButtonVariant="primary"
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const confirmButton = Array.from(buttons).find((btn) => btn.textContent === 'Confirm');
      expect(confirmButton?.className).toContain('bg-accent-hover');
      expect(confirmButton?.className).toContain('hover:bg-accent-hover');
    });

    it('should style cancel button consistently', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const cancelButton = Array.from(buttons).find((btn) => btn.textContent === 'Cancel');
      expect(cancelButton?.className).toContain('bg-surface-raised');
    });
  });

  describe('Loading State', () => {
    it('should show "Processing..." text when loading', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
          isLoading={true}
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const confirmButton = Array.from(buttons).find((btn) =>
        btn.textContent?.includes('Processing')
      );
      expect(confirmButton).toBeTruthy();
      expect(confirmButton?.textContent).toBe('Processing...');
    });

    it('should disable confirm button when loading', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
          isLoading={true}
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const confirmButton = Array.from(buttons).find((btn) =>
        btn.textContent?.includes('Processing')
      ) as HTMLButtonElement;
      expect(confirmButton?.disabled).toBe(true);
    });

    it('should disable cancel button when loading', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
          isLoading={true}
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const cancelButton = Array.from(buttons).find(
        (btn) => btn.textContent === 'Cancel'
      ) as HTMLButtonElement;
      expect(cancelButton?.disabled).toBe(true);
    });

    it('should not show "Processing..." when not loading', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
          isLoading={false}
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const processingButton = Array.from(buttons).find((btn) =>
        btn.textContent?.includes('Processing')
      );
      expect(processingButton).toBeFalsy();
    });

    it('should apply disabled styles when loading', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
          isLoading={true}
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const confirmButton = Array.from(buttons).find((btn) =>
        btn.textContent?.includes('Processing')
      );
      expect(confirmButton?.className).toContain('disabled:cursor-not-allowed');
    });
  });

  describe('Interactions', () => {
    it('should call onConfirm when confirm button is clicked', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const confirmButton = Array.from(buttons).find((btn) => btn.textContent === 'Confirm');
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when cancel button is clicked', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const cancelButton = Array.from(buttons).find((btn) => btn.textContent === 'Cancel');
      cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when Escape is pressed', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );

      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(escapeEvent);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when backdrop is clicked', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );

      const backdrop = document.body.querySelector('.bg-scrim');
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should not call onConfirm when loading', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
          isLoading={true}
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const confirmButton = Array.from(buttons).find((btn) =>
        btn.textContent?.includes('Processing')
      );
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onConfirm).not.toHaveBeenCalled();
    });
  });

  describe('Modal Size', () => {
    it('should use small size', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const modal = document.body.querySelector('.bg-surface');
      expect(modal?.className).toContain('max-w-md');
    });
  });

  describe('Styling', () => {
    it('should have proper button layout', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const actionsContainer = document.body.querySelector('.justify-end');
      expect(actionsContainer).toBeTruthy();
      expect(actionsContainer?.className).toContain('flex');
      expect(actionsContainer?.className).toContain('gap-3');
    });

    it('should have message styling', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const message = document.body.querySelector('p');
      expect(message?.className).toContain('text-fg-soft');
      expect(message?.className).toContain('text-sm');
    });

    it('should have white text on confirm button', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const buttons = document.body.querySelectorAll('button[type="button"]');
      const confirmButton = Array.from(buttons).find((btn) => btn.textContent === 'Confirm');
      expect(confirmButton?.className).toContain('text-accent-fg');
    });
  });

  describe('Accessibility', () => {
    it('should have proper button types', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const buttons = document.body.querySelectorAll('button');
      buttons.forEach((button) => {
        expect(button.type).toBe('button');
      });
    });

    it('should be rendered in portal', () => {
      const onClose = vi.fn(() => {});
      const onConfirm = vi.fn(() => {});
      render(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Title"
          message="Message"
        />
      );
      const portal = document.body.querySelector('[data-portal="true"]');
      expect(portal).toBeTruthy();
    });
  });
});
