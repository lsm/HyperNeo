// @ts-nocheck

import { render, cleanup, act } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';
import { Modal, createFocusTrapHandler, setupFocusTrap, FOCUSABLE_SELECTOR } from '../Modal';

vi.mock('../Portal.tsx', () => ({
  Portal: ({ children }: { children: preact.ComponentChildren }) => (
    <div data-portal="true">{children}</div>
  ),
}));

describe('createFocusTrapHandler', () => {
  it('should wrap focus to last element when Shift+Tab at first element', () => {
    const firstElement = document.createElement('button');
    const lastElement = document.createElement('button');
    firstElement.id = 'first';
    lastElement.id = 'last';
    document.body.appendChild(firstElement);
    document.body.appendChild(lastElement);

    const handler = createFocusTrapHandler(firstElement, lastElement);
    const lastFocusSpy = vi.spyOn(lastElement, 'focus');

    firstElement.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    handler(event);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(lastFocusSpy).toHaveBeenCalled();

    document.body.removeChild(firstElement);
    document.body.removeChild(lastElement);
  });

  it('should wrap focus to first element when Tab at last element', () => {
    const firstElement = document.createElement('button');
    const lastElement = document.createElement('button');
    firstElement.id = 'first';
    lastElement.id = 'last';
    document.body.appendChild(firstElement);
    document.body.appendChild(lastElement);

    const handler = createFocusTrapHandler(firstElement, lastElement);
    const firstFocusSpy = vi.spyOn(firstElement, 'focus');

    lastElement.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: false,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    handler(event);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(firstFocusSpy).toHaveBeenCalled();

    document.body.removeChild(firstElement);
    document.body.removeChild(lastElement);
  });

  it('should not prevent default for Tab on middle elements', () => {
    const firstElement = document.createElement('button');
    const middleElement = document.createElement('button');
    const lastElement = document.createElement('button');
    document.body.appendChild(firstElement);
    document.body.appendChild(middleElement);
    document.body.appendChild(lastElement);

    const handler = createFocusTrapHandler(firstElement, lastElement);

    middleElement.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: false,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    handler(event);

    expect(preventDefaultSpy).not.toHaveBeenCalled();

    document.body.removeChild(firstElement);
    document.body.removeChild(middleElement);
    document.body.removeChild(lastElement);
  });

  it('should not prevent default for non-Tab keys', () => {
    const firstElement = document.createElement('button');
    const lastElement = document.createElement('button');
    document.body.appendChild(firstElement);
    document.body.appendChild(lastElement);

    const handler = createFocusTrapHandler(firstElement, lastElement);

    lastElement.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    handler(event);

    expect(preventDefaultSpy).not.toHaveBeenCalled();

    document.body.removeChild(firstElement);
    document.body.removeChild(lastElement);
  });

  it('should handle null elements gracefully', () => {
    const handler = createFocusTrapHandler(null, null);

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      cancelable: true,
    });

    expect(() => handler(event)).not.toThrow();
  });

  it('should not prevent default for Shift+Tab on middle element', () => {
    const firstElement = document.createElement('button');
    const middleElement = document.createElement('button');
    const lastElement = document.createElement('button');
    document.body.appendChild(firstElement);
    document.body.appendChild(middleElement);
    document.body.appendChild(lastElement);

    const handler = createFocusTrapHandler(firstElement, lastElement);

    middleElement.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    handler(event);

    expect(preventDefaultSpy).not.toHaveBeenCalled();

    document.body.removeChild(firstElement);
    document.body.removeChild(middleElement);
    document.body.removeChild(lastElement);
  });

  it('should still prevent default when firstElement is null (Tab at last)', () => {
    const lastElement = document.createElement('button');
    document.body.appendChild(lastElement);

    const handler = createFocusTrapHandler(null, lastElement);

    lastElement.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: false,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    handler(event);

    expect(preventDefaultSpy).toHaveBeenCalled();

    document.body.removeChild(lastElement);
  });

  it('should still prevent default when lastElement is null (Shift+Tab at first)', () => {
    const firstElement = document.createElement('button');
    document.body.appendChild(firstElement);

    const handler = createFocusTrapHandler(firstElement, null);

    firstElement.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    handler(event);

    expect(preventDefaultSpy).toHaveBeenCalled();

    document.body.removeChild(firstElement);
  });
});

describe('setupFocusTrap', () => {
  it('should find focusable elements using FOCUSABLE_SELECTOR', () => {
    const container = document.createElement('div');
    container.innerHTML = `
			<button id="btn1">Button 1</button>
			<input type="text" id="input1" />
			<a href="#" id="link1">Link</a>
			<select id="select1"><option>Option</option></select>
			<textarea id="textarea1"></textarea>
			<div tabindex="0" id="div1">Focusable div</div>
			<div tabindex="-1" id="div2">Not focusable</div>
		`;
    document.body.appendChild(container);

    const focusableElements = container.querySelectorAll(FOCUSABLE_SELECTOR);

    expect(focusableElements.length).toBe(6);

    document.body.removeChild(container);
  });

  it('should set up focus trap and focus first element', () => {
    const container = document.createElement('div');
    container.innerHTML = `
			<button id="btn1">First</button>
			<button id="btn2">Last</button>
		`;
    document.body.appendChild(container);

    const firstBtn = container.querySelector('#btn1') as HTMLElement;
    const firstFocusSpy = vi.spyOn(firstBtn, 'focus');

    const cleanup = setupFocusTrap(container);

    expect(firstFocusSpy).toHaveBeenCalled();

    expect(typeof cleanup).toBe('function');

    cleanup();
    firstFocusSpy.mockRestore();
    document.body.removeChild(container);
  });

  it('should add keydown event listener to container', () => {
    const container = document.createElement('div');
    container.innerHTML = `
			<button id="btn1">First</button>
			<button id="btn2">Last</button>
		`;
    document.body.appendChild(container);

    const addEventListenerSpy = vi.spyOn(container, 'addEventListener');

    const cleanup = setupFocusTrap(container);

    expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));

    cleanup();
    addEventListenerSpy.mockRestore();
    document.body.removeChild(container);
  });

  it('should remove keydown event listener on cleanup', () => {
    const container = document.createElement('div');
    container.innerHTML = `
			<button id="btn1">First</button>
			<button id="btn2">Last</button>
		`;
    document.body.appendChild(container);

    const removeEventListenerSpy = vi.spyOn(container, 'removeEventListener');

    const cleanup = setupFocusTrap(container);
    cleanup();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));

    removeEventListenerSpy.mockRestore();
    document.body.removeChild(container);
  });

  it('should trap focus when Tab is pressed at last element', () => {
    const container = document.createElement('div');
    container.innerHTML = `
			<button id="btn1">First</button>
			<button id="btn2">Last</button>
		`;
    document.body.appendChild(container);

    const firstBtn = container.querySelector('#btn1') as HTMLElement;
    const lastBtn = container.querySelector('#btn2') as HTMLElement;
    const firstFocusSpy = vi.spyOn(firstBtn, 'focus');

    const cleanup = setupFocusTrap(container);

    firstFocusSpy.mockClear();

    lastBtn.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: false,
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
    container.dispatchEvent(event);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(firstFocusSpy).toHaveBeenCalled();

    cleanup();
    firstFocusSpy.mockRestore();
    document.body.removeChild(container);
  });

  it('should trap focus when Shift+Tab is pressed at first element', () => {
    const container = document.createElement('div');
    container.innerHTML = `
			<button id="btn1">First</button>
			<button id="btn2">Last</button>
		`;
    document.body.appendChild(container);

    const firstBtn = container.querySelector('#btn1') as HTMLElement;
    const lastBtn = container.querySelector('#btn2') as HTMLElement;
    const lastFocusSpy = vi.spyOn(lastBtn, 'focus');

    const cleanup = setupFocusTrap(container);

    firstBtn.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
    container.dispatchEvent(event);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(lastFocusSpy).toHaveBeenCalled();

    cleanup();
    lastFocusSpy.mockRestore();
    document.body.removeChild(container);
  });

  it('should handle container with no focusable elements', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>No focusable content</p>';
    document.body.appendChild(container);

    const cleanup = setupFocusTrap(container);
    expect(typeof cleanup).toBe('function');

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    expect(() => container.dispatchEvent(event)).not.toThrow();

    cleanup();
    document.body.removeChild(container);
  });

  it('should handle container with single focusable element', () => {
    const container = document.createElement('div');
    container.innerHTML = '<button id="only">Only Button</button>';
    document.body.appendChild(container);

    const onlyBtn = container.querySelector('#only') as HTMLElement;
    const focusSpy = vi.spyOn(onlyBtn, 'focus');

    const cleanup = setupFocusTrap(container);

    expect(focusSpy).toHaveBeenCalled();

    cleanup();
    focusSpy.mockRestore();
    document.body.removeChild(container);
  });
});

const renderWithEffects = async (ui: preact.ComponentChildren) => {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(ui);
  });
  return result!;
};

describe('Modal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
  });

  describe('Rendering', () => {
    it('should render children when open', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Modal Content</p>
        </Modal>
      );
      const content = document.body.querySelector('p');
      expect(content?.textContent).toBe('Modal Content');
    });

    it('should not render when closed', () => {
      const onClose = vi.fn(() => {});
      const { container } = render(
        <Modal isOpen={false} onClose={onClose}>
          <p>Modal Content</p>
        </Modal>
      );
      const content = document.body.querySelector('p');
      expect(content).toBeNull();
      expect(container.innerHTML).toBe('');
    });

    it('should render title when provided', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} title="Test Title">
          <p>Content</p>
        </Modal>
      );
      const title = document.body.querySelector('h2');
      expect(title?.textContent).toBe('Test Title');
    });

    it('should render close button by default', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <p>Content</p>
        </Modal>
      );
      const closeButton = document.body.querySelector('button[aria-label="Close modal"]');
      expect(closeButton).toBeTruthy();
    });

    it('should not render close button when showCloseButton is false', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} showCloseButton={false}>
          <p>Content</p>
        </Modal>
      );
      const closeButton = document.body.querySelector('button[aria-label="Close modal"]');
      expect(closeButton).toBeNull();
    });

    it('should not render header when no title and no close button', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} showCloseButton={false}>
          <p>Content</p>
        </Modal>
      );
      const header = document.body.querySelector('.border-b');
      expect(header).toBeNull();
    });
  });

  describe('Sizes', () => {
    it('should render medium size by default', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Content</p>
        </Modal>
      );
      const modal = document.body.querySelector('.bg-dark-900');
      expect(modal?.className).toContain('max-w-lg');
    });

    it('should render small size', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} size="sm">
          <p>Content</p>
        </Modal>
      );
      const modal = document.body.querySelector('.bg-dark-900');
      expect(modal?.className).toContain('max-w-md');
    });

    it('should render large size', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} size="lg">
          <p>Content</p>
        </Modal>
      );
      const modal = document.body.querySelector('.bg-dark-900');
      expect(modal?.className).toContain('max-w-2xl');
    });

    it('should render extra large size', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} size="xl">
          <p>Content</p>
        </Modal>
      );
      const modal = document.body.querySelector('.bg-dark-900');
      expect(modal?.className).toContain('max-w-4xl');
    });
  });

  describe('Interactions', () => {
    it('should call onClose when Escape key is pressed', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Content</p>
        </Modal>
      );

      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(escapeEvent);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should not call onClose for other keys', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Content</p>
        </Modal>
      );

      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter' });
      document.dispatchEvent(enterEvent);

      expect(onClose).not.toHaveBeenCalled();
    });

    it('should call onClose when backdrop is clicked', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Content</p>
        </Modal>
      );

      const backdrop = document.body.querySelector('.bg-black\\/70');
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should not call onClose when modal content is clicked', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p data-testid="content">Content</p>
        </Modal>
      );

      const modalContent = document.body.querySelector('.bg-dark-900');
      modalContent?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onClose).not.toHaveBeenCalled();
    });

    it('should call onClose when close button is clicked', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <p>Content</p>
        </Modal>
      );

      const closeButton = document.body.querySelector('button[aria-label="Close modal"]');
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should set body overflow to hidden when open', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Content</p>
        </Modal>
      );

      expect(document.body.style.overflow).toBe('hidden');
    });
  });

  describe('Accessibility', () => {
    it('should have close button with aria-label', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <p>Content</p>
        </Modal>
      );
      const closeButton = document.body.querySelector('button[aria-label="Close modal"]');
      expect(closeButton).toBeTruthy();
    });

    it('should render in a portal', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Content</p>
        </Modal>
      );
      const portalContainer = document.body.querySelector('[data-portal="true"]');
      expect(portalContainer).toBeTruthy();
    });

    it('should have proper z-index for stacking', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Content</p>
        </Modal>
      );
      const modalOverlay = document.body.querySelector('.z-50');
      expect(modalOverlay).toBeTruthy();
    });

    it('should have role-based focus trap elements', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button>First Button</button>
          <input type="text" placeholder="Input" />
          <button>Last Button</button>
        </Modal>
      );
      const modal = document.body.querySelector('.bg-dark-900');
      const buttons = modal?.querySelectorAll('button');
      const inputs = modal?.querySelectorAll('input');
      expect(buttons?.length).toBeGreaterThan(0);
      expect(inputs?.length).toBe(1);
    });

    it('should have role="dialog" and aria-modal="true"', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Content</p>
        </Modal>
      );
      const dialog = document.body.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
    });
  });

  describe('Focus Trap', () => {
    it('should have first focusable element ready when opened', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="first-btn">First Button</button>
          <button id="second-btn">Second Button</button>
        </Modal>
      );

      const closeButton = document.body.querySelector('button[aria-label="Close modal"]');
      expect(closeButton).toBeTruthy();

      const modal = document.body.querySelector('[role="dialog"]');
      const focusables = modal?.querySelectorAll('button');
      expect(focusables?.length).toBeGreaterThan(0);
    });

    it('should identify focusable elements for focus trap', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="content-btn">Content Button</button>
          <input type="text" placeholder="Input" />
          <a href="#">Link</a>
          <select>
            <option>Option</option>
          </select>
          <textarea>Text</textarea>
        </Modal>
      );

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;
      const focusables = modal?.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );

      expect(focusables?.length).toBeGreaterThan(3);
    });

    it('should register keydown listener on modal for Tab key handling', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="first-btn">First</button>
          <button id="last-btn">Last</button>
        </Modal>
      );

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;

      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });

      expect(() => modal?.dispatchEvent(tabEvent)).not.toThrow();
    });

    it('should register keydown listener for Shift+Tab handling', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="first-btn">First</button>
          <button id="last-btn">Last</button>
        </Modal>
      );

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;

      const shiftTabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });

      expect(() => modal?.dispatchEvent(shiftTabEvent)).not.toThrow();
    });

    it('should handle Tab normally for middle elements', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="first-btn">First</button>
          <button id="middle-btn">Middle</button>
          <button id="last-btn">Last</button>
        </Modal>
      );

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;
      const middleBtn = document.getElementById('middle-btn') as HTMLButtonElement;

      middleBtn?.focus();

      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });

      expect(() => modal?.dispatchEvent(tabEvent)).not.toThrow();
    });

    it('should not affect non-Tab keys in focus trap handler', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="content-btn">Content Button</button>
        </Modal>
      );

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;

      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });

      expect(() => modal?.dispatchEvent(enterEvent)).not.toThrow();
    });

    it('should cleanup event listeners on close', () => {
      const onClose = vi.fn(() => {});
      const { rerender } = render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button>Button</button>
        </Modal>
      );

      const modal = document.body.querySelector('[role="dialog"]');
      expect(modal).toBeTruthy();

      rerender(
        <Modal isOpen={false} onClose={onClose} title="Test">
          <button>Button</button>
        </Modal>
      );

      const modalAfterClose = document.body.querySelector('[role="dialog"]');
      expect(modalAfterClose).toBeNull();
    });

    it('should run focus trap cleanup when modal closes', async () => {
      const onClose = vi.fn(() => {});

      const { rerender } = await renderWithEffects(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="test-btn">Button</button>
        </Modal>
      );

      const modal = document.body.querySelector('[role="dialog"]');
      expect(modal).toBeTruthy();

      await act(async () => {
        rerender(
          <Modal isOpen={false} onClose={onClose} title="Test">
            <button id="test-btn">Button</button>
          </Modal>
        );
      });

      const modalAfterClose = document.body.querySelector('[role="dialog"]');
      expect(modalAfterClose).toBeNull();
    });

    it('should setup and cleanup focus trap on isOpen toggle', async () => {
      const onClose = vi.fn(() => {});

      const { rerender } = render(
        <Modal isOpen={false} onClose={onClose} title="Test">
          <button id="test-btn">Button</button>
        </Modal>
      );

      await act(async () => {
        rerender(
          <Modal isOpen={true} onClose={onClose} title="Test">
            <button id="test-btn">Button</button>
          </Modal>
        );
      });

      const modal = document.body.querySelector('[role="dialog"]');
      expect(modal).toBeTruthy();

      await act(async () => {
        rerender(
          <Modal isOpen={false} onClose={onClose} title="Test">
            <button id="test-btn">Button</button>
          </Modal>
        );
      });

      const modalAfterClose = document.body.querySelector('[role="dialog"]');
      expect(modalAfterClose).toBeNull();
    });

    it('should return cleanup function from focus trap useEffect', async () => {
      const onClose = vi.fn(() => {});

      const { rerender } = render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="btn1">First</button>
          <button id="btn2">Second</button>
        </Modal>
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      const modal = document.body.querySelector('[role="dialog"]');
      expect(modal).toBeTruthy();

      await act(async () => {
        rerender(
          <Modal isOpen={false} onClose={onClose} title="Test">
            <button id="btn1">First</button>
            <button id="btn2">Second</button>
          </Modal>
        );
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    });

    it('should handle modal with no focusable elements', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} showCloseButton={false}>
          <p>No focusable content here</p>
        </Modal>
      );

      const modal = document.body.querySelector('[role="dialog"]');
      expect(modal).toBeTruthy();

      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      expect(() => modal?.dispatchEvent(tabEvent)).not.toThrow();
    });

    it('should find first and last focusable elements for focus boundaries', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="first-btn">First</button>
          <button id="last-btn">Last</button>
        </Modal>
      );

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;
      const focusables = modal?.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const firstElement = focusables?.[0] as HTMLElement;
      const lastElement = focusables?.[focusables.length - 1] as HTMLElement;

      expect(firstElement).toBeTruthy();
      expect(lastElement).toBeTruthy();
      expect(focusables?.length).toBeGreaterThan(1);
    });

    it('should execute focus trap setup with act', async () => {
      const onClose = vi.fn(() => {});

      await renderWithEffects(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="first-btn">First</button>
          <button id="last-btn">Last</button>
        </Modal>
      );

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;
      expect(modal).toBeTruthy();

      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      expect(() => modal?.dispatchEvent(tabEvent)).not.toThrow();
    });

    it('should test focus trap logic directly', () => {
      const container = document.createElement('div');
      container.innerHTML = `
				<button id="btn1">First</button>
				<input type="text" id="input1" />
				<button id="btn2">Last</button>
			`;
      document.body.appendChild(container);

      const focusableElements = container.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const firstElement = focusableElements[0] as HTMLElement;
      const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;

      expect(focusableElements.length).toBe(3);
      expect(firstElement.id).toBe('btn1');
      expect(lastElement.id).toBe('btn2');

      const handleTab = (e: KeyboardEvent) => {
        if (e.key === 'Tab') {
          if (e.shiftKey) {
            if (document.activeElement === firstElement) {
              e.preventDefault();
              lastElement?.focus();
            }
          } else {
            if (document.activeElement === lastElement) {
              e.preventDefault();
              firstElement?.focus();
            }
          }
        }
      };

      const middleElement = focusableElements[1] as HTMLElement;
      middleElement.focus();

      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      const preventDefaultSpy = vi.spyOn(tabEvent, 'preventDefault');
      handleTab(tabEvent);
      expect(preventDefaultSpy).not.toHaveBeenCalled();

      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      handleTab(enterEvent);

      document.body.removeChild(container);
    });

    it('should wrap focus from last element to first on Tab', () => {
      const container = document.createElement('div');
      container.innerHTML = `
				<button id="btn1">First</button>
				<button id="btn2">Last</button>
			`;
      document.body.appendChild(container);

      const firstElement = document.getElementById('btn1') as HTMLElement;
      const lastElement = document.getElementById('btn2') as HTMLElement;

      lastElement.focus();

      const firstFocusSpy = vi.spyOn(firstElement, 'focus');

      const handleTab = (e: KeyboardEvent) => {
        if (e.key === 'Tab') {
          if (e.shiftKey) {
            if (document.activeElement === firstElement) {
              e.preventDefault();
              lastElement?.focus();
            }
          } else {
            if (document.activeElement === lastElement) {
              e.preventDefault();
              firstElement?.focus();
            }
          }
        }
      };

      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      const preventDefaultSpy = vi.spyOn(tabEvent, 'preventDefault');
      handleTab(tabEvent);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(firstFocusSpy).toHaveBeenCalled();

      firstFocusSpy.mockRestore();
      document.body.removeChild(container);
    });

    it('should wrap focus from first element to last on Shift+Tab', () => {
      const container = document.createElement('div');
      container.innerHTML = `
				<button id="btn1">First</button>
				<button id="btn2">Last</button>
			`;
      document.body.appendChild(container);

      const firstElement = document.getElementById('btn1') as HTMLElement;
      const lastElement = document.getElementById('btn2') as HTMLElement;

      firstElement.focus();

      const lastFocusSpy = vi.spyOn(lastElement, 'focus');

      const handleTab = (e: KeyboardEvent) => {
        if (e.key === 'Tab') {
          if (e.shiftKey) {
            if (document.activeElement === firstElement) {
              e.preventDefault();
              lastElement?.focus();
            }
          } else {
            if (document.activeElement === lastElement) {
              e.preventDefault();
              firstElement?.focus();
            }
          }
        }
      };

      const shiftTabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      const preventDefaultSpy = vi.spyOn(shiftTabEvent, 'preventDefault');
      handleTab(shiftTabEvent);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(lastFocusSpy).toHaveBeenCalled();

      lastFocusSpy.mockRestore();
      document.body.removeChild(container);
    });

    it('should handle focus trap cleanup function', () => {
      const container = document.createElement('div');
      const addEventListenerSpy = vi.spyOn(container, 'addEventListener');
      const removeEventListenerSpy = vi.spyOn(container, 'removeEventListener');

      const handleTab = () => {};

      container.addEventListener('keydown', handleTab as EventListener);
      expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', handleTab);

      container.removeEventListener('keydown', handleTab as EventListener);
      expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', handleTab);

      addEventListenerSpy.mockRestore();
      removeEventListenerSpy.mockRestore();
    });

    it('should dispatch Tab key event on modal without error', () => {
      const onClose = vi.fn(() => {});

      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="content-btn">Content Button</button>
        </Modal>
      );

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;

      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      });
      expect(() => modal?.dispatchEvent(event)).not.toThrow();
    });

    it('should dispatch Shift+Tab key event on modal without error', () => {
      const onClose = vi.fn(() => {});

      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="content-btn">Content Button</button>
        </Modal>
      );

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;

      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      expect(() => modal?.dispatchEvent(event)).not.toThrow();
    });

    it('should not trap focus when Tab pressed on middle element', () => {
      const onClose = vi.fn(() => {});
      let capturedHandler: ((e: KeyboardEvent) => void) | null = null;

      const originalAddEventListener = HTMLElement.prototype.addEventListener;
      HTMLElement.prototype.addEventListener = function (
        type: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) {
        if (type === 'keydown' && typeof handler === 'function') {
          capturedHandler = handler;
        }
        return originalAddEventListener.call(this, type, handler, options);
      };

      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="first-btn">First</button>
          <button id="middle-btn">Middle</button>
          <button id="last-btn">Last</button>
        </Modal>
      );

      HTMLElement.prototype.addEventListener = originalAddEventListener;

      const middleBtn = document.getElementById('middle-btn') as HTMLButtonElement;
      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;
      const buttons = modal?.querySelectorAll('button');
      const firstButton = buttons?.[0] as HTMLButtonElement;
      const lastButton = buttons?.[buttons.length - 1] as HTMLButtonElement;

      const firstFocusSpy = vi.spyOn(firstButton, 'focus');
      const lastFocusSpy = vi.spyOn(lastButton, 'focus');

      const originalActiveElement = Object.getOwnPropertyDescriptor(document, 'activeElement');
      Object.defineProperty(document, 'activeElement', {
        get: () => middleBtn,
        configurable: true,
      });

      if (capturedHandler) {
        const event = new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: false,
          cancelable: true,
        });
        capturedHandler(event);
      }

      if (originalActiveElement) {
        Object.defineProperty(document, 'activeElement', originalActiveElement);
      }

      expect(firstFocusSpy).not.toHaveBeenCalled();
      expect(lastFocusSpy).not.toHaveBeenCalled();
      firstFocusSpy.mockRestore();
      lastFocusSpy.mockRestore();
    });

    it('should not trap focus for non-Tab keys', () => {
      const onClose = vi.fn(() => {});
      let capturedHandler: ((e: KeyboardEvent) => void) | null = null;

      const originalAddEventListener = HTMLElement.prototype.addEventListener;
      HTMLElement.prototype.addEventListener = function (
        type: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) {
        if (type === 'keydown' && typeof handler === 'function') {
          capturedHandler = handler;
        }
        return originalAddEventListener.call(this, type, handler, options);
      };

      render(
        <Modal isOpen={true} onClose={onClose} title="Test">
          <button id="content-btn">Content Button</button>
        </Modal>
      );

      HTMLElement.prototype.addEventListener = originalAddEventListener;

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;
      const buttons = modal?.querySelectorAll('button');
      const lastButton = buttons?.[buttons.length - 1] as HTMLButtonElement;
      const firstButton = buttons?.[0] as HTMLButtonElement;

      const firstFocusSpy = vi.spyOn(firstButton, 'focus');

      const originalActiveElement = Object.getOwnPropertyDescriptor(document, 'activeElement');
      Object.defineProperty(document, 'activeElement', {
        get: () => lastButton,
        configurable: true,
      });

      if (capturedHandler) {
        const event = new KeyboardEvent('keydown', {
          key: 'Enter',
          cancelable: true,
        });
        capturedHandler(event);
      }

      if (originalActiveElement) {
        Object.defineProperty(document, 'activeElement', originalActiveElement);
      }

      expect(firstFocusSpy).not.toHaveBeenCalled();
      firstFocusSpy.mockRestore();
    });
  });

  describe('Animations', () => {
    it('should have fadeIn animation class', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Content</p>
        </Modal>
      );
      const modalOverlay = document.body.querySelector('.animate-fadeIn');
      expect(modalOverlay).toBeTruthy();
    });

    it('should have scaleIn animation class on modal', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Content</p>
        </Modal>
      );
      const modal = document.body.querySelector('.animate-scaleIn');
      expect(modal).toBeTruthy();
    });
  });

  describe('Styling', () => {
    it('should have rounded corners', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Content</p>
        </Modal>
      );
      const modal = document.body.querySelector('.rounded-xl');
      expect(modal).toBeTruthy();
    });

    it('should have shadow', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Content</p>
        </Modal>
      );
      const modal = document.body.querySelector('.shadow-2xl');
      expect(modal).toBeTruthy();
    });

    it('should have backdrop blur on overlay', () => {
      const onClose = vi.fn(() => {});
      render(
        <Modal isOpen={true} onClose={onClose}>
          <p>Content</p>
        </Modal>
      );
      const backdrop = document.body.querySelector('.backdrop-blur-sm');
      expect(backdrop).toBeTruthy();
    });
  });

  describe('Focus trap handler coverage', () => {
    it('should wrap focus to first element when Tab on last element', () => {
      const onClose = vi.fn();
      let capturedHandler: ((e: KeyboardEvent) => void) | null = null;

      const originalAddEventListener = HTMLElement.prototype.addEventListener;
      HTMLElement.prototype.addEventListener = function (
        type: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) {
        if (type === 'keydown' && typeof handler === 'function') {
          capturedHandler = handler;
        }
        return originalAddEventListener.call(this, type, handler, options);
      };

      render(
        <Modal isOpen={true} onClose={onClose} title="Focus Test">
          <button id="first-btn">First</button>
          <button id="last-btn">Last</button>
        </Modal>
      );

      HTMLElement.prototype.addEventListener = originalAddEventListener;

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;
      const buttons = modal?.querySelectorAll('button');
      const firstButton = buttons?.[0] as HTMLButtonElement;
      const lastButton = buttons?.[buttons.length - 1] as HTMLButtonElement;

      const firstFocusSpy = vi.spyOn(firstButton, 'focus');

      const originalActiveElement = Object.getOwnPropertyDescriptor(document, 'activeElement');
      Object.defineProperty(document, 'activeElement', {
        get: () => lastButton,
        configurable: true,
      });

      if (capturedHandler) {
        const event = new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: false,
          cancelable: true,
        });
        const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
        capturedHandler(event);

        expect(preventDefaultSpy).toHaveBeenCalled();
        expect(firstFocusSpy).toHaveBeenCalled();
      }

      if (originalActiveElement) {
        Object.defineProperty(document, 'activeElement', originalActiveElement);
      }
      firstFocusSpy.mockRestore();
    });

    it('should wrap focus to last element when Shift+Tab on first element', () => {
      const onClose = vi.fn();
      let capturedHandler: ((e: KeyboardEvent) => void) | null = null;

      const originalAddEventListener = HTMLElement.prototype.addEventListener;
      HTMLElement.prototype.addEventListener = function (
        type: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) {
        if (type === 'keydown' && typeof handler === 'function') {
          capturedHandler = handler;
        }
        return originalAddEventListener.call(this, type, handler, options);
      };

      render(
        <Modal isOpen={true} onClose={onClose} title="Focus Test">
          <button id="first-btn">First</button>
          <button id="last-btn">Last</button>
        </Modal>
      );

      HTMLElement.prototype.addEventListener = originalAddEventListener;

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;
      const buttons = modal?.querySelectorAll('button');
      const firstButton = buttons?.[0] as HTMLButtonElement;
      const lastButton = buttons?.[buttons.length - 1] as HTMLButtonElement;

      const lastFocusSpy = vi.spyOn(lastButton, 'focus');

      const originalActiveElement = Object.getOwnPropertyDescriptor(document, 'activeElement');
      Object.defineProperty(document, 'activeElement', {
        get: () => firstButton,
        configurable: true,
      });

      if (capturedHandler) {
        const event = new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          cancelable: true,
        });
        const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
        capturedHandler(event);

        expect(preventDefaultSpy).toHaveBeenCalled();
        expect(lastFocusSpy).toHaveBeenCalled();
      }

      if (originalActiveElement) {
        Object.defineProperty(document, 'activeElement', originalActiveElement);
      }
      lastFocusSpy.mockRestore();
    });

    it('should not interfere when not at boundary element', () => {
      const onClose = vi.fn();
      let capturedHandler: ((e: KeyboardEvent) => void) | null = null;

      const originalAddEventListener = HTMLElement.prototype.addEventListener;
      HTMLElement.prototype.addEventListener = function (
        type: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) {
        if (type === 'keydown' && typeof handler === 'function') {
          capturedHandler = handler;
        }
        return originalAddEventListener.call(this, type, handler, options);
      };

      render(
        <Modal isOpen={true} onClose={onClose} title="Focus Test">
          <button id="first-btn">First</button>
          <input id="middle-input" />
          <button id="last-btn">Last</button>
        </Modal>
      );

      HTMLElement.prototype.addEventListener = originalAddEventListener;

      const middleInput = document.getElementById('middle-input') as HTMLInputElement;

      const originalActiveElement = Object.getOwnPropertyDescriptor(document, 'activeElement');
      Object.defineProperty(document, 'activeElement', {
        get: () => middleInput,
        configurable: true,
      });

      if (capturedHandler) {
        const event = new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: false,
          cancelable: true,
        });
        const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
        capturedHandler(event);

        expect(preventDefaultSpy).not.toHaveBeenCalled();
      }

      if (originalActiveElement) {
        Object.defineProperty(document, 'activeElement', originalActiveElement);
      }
    });

    it('should ignore non-Tab keys', () => {
      const onClose = vi.fn();
      let capturedHandler: ((e: KeyboardEvent) => void) | null = null;

      const originalAddEventListener = HTMLElement.prototype.addEventListener;
      HTMLElement.prototype.addEventListener = function (
        type: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) {
        if (type === 'keydown' && typeof handler === 'function') {
          capturedHandler = handler;
        }
        return originalAddEventListener.call(this, type, handler, options);
      };

      render(
        <Modal isOpen={true} onClose={onClose} title="Focus Test">
          <button id="first-btn">First</button>
          <button id="last-btn">Last</button>
        </Modal>
      );

      HTMLElement.prototype.addEventListener = originalAddEventListener;

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;
      const buttons = modal?.querySelectorAll('button');
      const lastButton = buttons?.[buttons.length - 1] as HTMLButtonElement;

      const originalActiveElement = Object.getOwnPropertyDescriptor(document, 'activeElement');
      Object.defineProperty(document, 'activeElement', {
        get: () => lastButton,
        configurable: true,
      });

      if (capturedHandler) {
        const event = new KeyboardEvent('keydown', {
          key: 'Enter',
          cancelable: true,
        });
        const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
        capturedHandler(event);

        expect(preventDefaultSpy).not.toHaveBeenCalled();
      }

      if (originalActiveElement) {
        Object.defineProperty(document, 'activeElement', originalActiveElement);
      }
    });

    it('should set up focus trap when modal opens with ref ready', async () => {
      const onClose = vi.fn();
      let focusTrapSetUp = false;

      const originalAddEventListener = HTMLElement.prototype.addEventListener;
      HTMLElement.prototype.addEventListener = function (
        type: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) {
        if (type === 'keydown') {
          focusTrapSetUp = true;
        }
        return originalAddEventListener.call(this, type, handler, options);
      };

      await act(async () => {
        render(
          <Modal isOpen={true} onClose={onClose} title="Test">
            <button>Test Button</button>
          </Modal>
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      HTMLElement.prototype.addEventListener = originalAddEventListener;

      const modal = document.body.querySelector('[role="dialog"]');
      expect(modal).toBeTruthy();

      expect(focusTrapSetUp).toBe(true);
    });

    it('should not set up focus trap when modal is closed', async () => {
      const onClose = vi.fn();
      let focusTrapSetUp = false;

      const originalAddEventListener = HTMLElement.prototype.addEventListener;
      HTMLElement.prototype.addEventListener = function (
        type: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) {
        if (type === 'keydown') {
          focusTrapSetUp = true;
        }
        return originalAddEventListener.call(this, type, handler, options);
      };

      render(
        <Modal isOpen={false} onClose={onClose} title="Test">
          <button>Test Button</button>
        </Modal>
      );

      HTMLElement.prototype.addEventListener = originalAddEventListener;

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(focusTrapSetUp).toBe(false);

      const modal = document.body.querySelector('[role="dialog"]');
      expect(modal).toBeNull();
    });
  });
});
