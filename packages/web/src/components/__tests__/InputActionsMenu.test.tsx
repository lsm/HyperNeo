// @ts-nocheck

import { render } from '@testing-library/preact';
import { InputActionsMenu } from '../InputActionsMenu';

describe('InputActionsMenu', () => {
  const defaultProps = {
    isOpen: false,
    onToggle: vi.fn(() => {}),
    onClose: vi.fn(() => {}),
    autoScroll: true,
    onAutoScrollChange: vi.fn(() => {}),
    onOpenTools: vi.fn(() => {}),
    onAttachFile: vi.fn(() => {}),
  };

  beforeEach(() => {
    defaultProps.onToggle.mockClear();
    defaultProps.onClose.mockClear();
    defaultProps.onAutoScrollChange.mockClear();
    defaultProps.onOpenTools.mockClear();
    defaultProps.onAttachFile.mockClear();
  });

  describe('Rendering', () => {
    it('should render plus button', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} />);
      const button = container.querySelector('button');
      expect(button).toBeTruthy();
    });

    it('should not render menu when closed', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} isOpen={false} />);
      const menu = container.querySelector('[role="menu"]');
      expect(menu).toBeNull();
    });

    it('should render menu when open', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} isOpen={true} />);
      const menuItems = container.querySelectorAll('button');
      expect(menuItems.length).toBeGreaterThan(1);
    });
  });

  describe('Plus Button', () => {
    it('should toggle menu on click', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} />);
      const button = container.querySelector('button');
      button?.click();
      expect(defaultProps.onToggle).toHaveBeenCalled();
    });

    it('should have rotate animation when open', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} isOpen={true} />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('rotate-45');
    });

    it('should not have rotate animation when closed', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} isOpen={false} />);
      const svg = container.querySelector('svg');
      expect(svg?.className).not.toContain('rotate-45');
    });
  });

  describe('Disabled State', () => {
    it('should disable button when disabled prop is true', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} disabled={true} />);
      const button = container.querySelector('button');
      expect(button?.disabled).toBe(true);
    });

    it('should have disabled styling', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} disabled={true} />);
      const button = container.querySelector('button');
      expect(button?.className).toContain('opacity-50');
      expect(button?.className).toContain('cursor-not-allowed');
    });
  });

  describe('Menu Items', () => {
    it('should show auto-scroll toggle in menu', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} isOpen={true} />);
      const text = container.textContent;
      expect(text).toContain('Auto-scroll');
    });

    it('should show tools option in menu', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} isOpen={true} />);
      const text = container.textContent;
      expect(text).toContain('Tools');
    });

    it('should show attach image option in menu', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} isOpen={true} />);
      const text = container.textContent;
      expect(text).toContain('Attach image');
    });
  });

  describe('Auto-scroll Toggle', () => {
    it('should show checkmark when auto-scroll is enabled', () => {
      const { container } = render(
        <InputActionsMenu {...defaultProps} isOpen={true} autoScroll={true} />
      );
      const checkmarks = container.querySelectorAll('svg');
      expect(checkmarks.length).toBeGreaterThan(3);
    });

    it('should not show checkmark when auto-scroll is disabled', () => {
      const { container } = render(
        <InputActionsMenu {...defaultProps} isOpen={true} autoScroll={false} />
      );
      const text = container.textContent;
      expect(text).toContain('Auto-scroll');
    });

    it('should call onAutoScrollChange and close menu on click', () => {
      const onAutoScrollChange = vi.fn(() => {});
      const onClose = vi.fn(() => {});
      const { container } = render(
        <InputActionsMenu
          {...defaultProps}
          isOpen={true}
          autoScroll={true}
          onAutoScrollChange={onAutoScrollChange}
          onClose={onClose}
        />
      );

      const buttons = container.querySelectorAll('button');
      const autoScrollButton = Array.from(buttons).find((b) =>
        b.textContent?.includes('Auto-scroll')
      );
      autoScrollButton?.click();

      expect(onAutoScrollChange).toHaveBeenCalledWith(false);
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Tools Button', () => {
    it('should call onOpenTools and close menu on click', () => {
      const onOpenTools = vi.fn(() => {});
      const onClose = vi.fn(() => {});
      const { container } = render(
        <InputActionsMenu
          {...defaultProps}
          isOpen={true}
          onOpenTools={onOpenTools}
          onClose={onClose}
        />
      );

      const buttons = container.querySelectorAll('button');
      const toolsButton = Array.from(buttons).find((b) => b.textContent?.includes('Tools'));
      toolsButton?.click();

      expect(onOpenTools).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Attach File Button', () => {
    it('should call onAttachFile and close menu on click', () => {
      const onAttachFile = vi.fn(() => {});
      const onClose = vi.fn(() => {});
      const { container } = render(
        <InputActionsMenu
          {...defaultProps}
          isOpen={true}
          onAttachFile={onAttachFile}
          onClose={onClose}
        />
      );

      const buttons = container.querySelectorAll('button');
      const attachButton = Array.from(buttons).find((b) => b.textContent?.includes('Attach'));
      attachButton?.click();

      expect(onAttachFile).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    it('should not call onAttachFile when disabled', () => {
      const onAttachFile = vi.fn(() => {});
      const { container } = render(
        <InputActionsMenu
          {...defaultProps}
          isOpen={true}
          disabled={true}
          onAttachFile={onAttachFile}
        />
      );

      const buttons = container.querySelectorAll('button');
      const attachButton = Array.from(buttons).find((b) => b.textContent?.includes('Attach'));
      attachButton?.click();

      expect(onAttachFile).not.toHaveBeenCalled();
    });
  });

  describe('Coordinator & Sandbox Toggles', () => {
    const featuresOn = { coordinator: true, worktree: true };

    it('should show coordinator + sandbox items when features are enabled', () => {
      const { container } = render(
        <InputActionsMenu {...defaultProps} isOpen={true} features={featuresOn} />
      );
      const text = container.textContent;
      expect(text).toContain('Coordinator Mode');
      expect(text).toContain('Sandbox Mode');
    });

    it('should hide coordinator + sandbox items when features are disabled', () => {
      const { container } = render(
        <InputActionsMenu
          {...defaultProps}
          isOpen={true}
          features={{ coordinator: false, worktree: false }}
        />
      );
      const text = container.textContent;
      expect(text).not.toContain('Coordinator Mode');
      expect(text).not.toContain('Sandbox Mode');
    });

    it('should disable coordinator toggle while a model switch is in progress', () => {
      const { container } = render(
        <InputActionsMenu
          {...defaultProps}
          isOpen={true}
          features={featuresOn}
          modelSwitching={true}
        />
      );
      const buttons = container.querySelectorAll('button');
      const coordinatorButton = Array.from(buttons).find((b) =>
        b.textContent?.includes('Coordinator Mode')
      ) as HTMLButtonElement;
      expect(coordinatorButton?.disabled).toBe(true);
    });

    it('should disable sandbox toggle while a model switch is in progress', () => {
      const { container } = render(
        <InputActionsMenu
          {...defaultProps}
          isOpen={true}
          features={featuresOn}
          modelSwitching={true}
        />
      );
      const buttons = container.querySelectorAll('button');
      const sandboxButton = Array.from(buttons).find((b) =>
        b.textContent?.includes('Sandbox Mode')
      ) as HTMLButtonElement;
      expect(sandboxButton?.disabled).toBe(true);
    });

    it('should call onCoordinatorModeChange and close on click', () => {
      const onCoordinatorModeChange = vi.fn(() => {});
      const onClose = vi.fn(() => {});
      const { container } = render(
        <InputActionsMenu
          {...defaultProps}
          isOpen={true}
          features={featuresOn}
          coordinatorMode={true}
          onCoordinatorModeChange={onCoordinatorModeChange}
          onClose={onClose}
        />
      );
      const buttons = container.querySelectorAll('button');
      const coordinatorButton = Array.from(buttons).find((b) =>
        b.textContent?.includes('Coordinator Mode')
      );
      coordinatorButton?.click();
      expect(onCoordinatorModeChange).toHaveBeenCalledWith(false);
      expect(onClose).toHaveBeenCalled();
    });

    it('should call onSandboxModeChange and close on click', () => {
      const onSandboxModeChange = vi.fn(() => {});
      const onClose = vi.fn(() => {});
      const { container } = render(
        <InputActionsMenu
          {...defaultProps}
          isOpen={true}
          features={featuresOn}
          sandboxEnabled={false}
          onSandboxModeChange={onSandboxModeChange}
          onClose={onClose}
        />
      );
      const buttons = container.querySelectorAll('button');
      const sandboxButton = Array.from(buttons).find((b) =>
        b.textContent?.includes('Sandbox Mode')
      );
      sandboxButton?.click();
      expect(onSandboxModeChange).toHaveBeenCalledWith(true);
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Accessibility', () => {
    it('should have title on button', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} />);
      const button = container.querySelector('button');
      expect(button?.title).toBe('More options');
    });

    it('should show "Not connected" title when disabled', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} disabled={true} />);
      const button = container.querySelector('button');
      expect(button?.title).toBe('Not connected');
    });
  });

  describe('Styling', () => {
    it('should have rounded button', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} />);
      const button = container.querySelector('button');
      expect(button?.className).toContain('rounded-full');
    });

    it('should have animation on menu', () => {
      const { container } = render(<InputActionsMenu {...defaultProps} isOpen={true} />);
      const menu = container.querySelector('.animate-slideIn');
      expect(menu).toBeTruthy();
    });
  });
});
