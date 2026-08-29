// @ts-nocheck

import { render, fireEvent, cleanup } from '@testing-library/preact';
import CommandAutocomplete from '../CommandAutocomplete';

describe('CommandAutocomplete', () => {
  const mockOnSelect = vi.fn(() => {});
  const mockOnClose = vi.fn(() => {});

  const mockCommands = ['/help', '/clear', '/reset', '/context', '/model'];

  beforeEach(() => {
    cleanup();
    mockOnSelect.mockClear();
    mockOnClose.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
    it('should render nothing when commands array is empty', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={[]}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(container.children.length).toBe(0);
    });

    it('should render dropdown when commands are provided', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(container.textContent).toContain('Slash Commands');
    });

    it('should render all commands', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(container.textContent).toContain('/help');
      expect(container.textContent).toContain('/clear');
      expect(container.textContent).toContain('/reset');
      expect(container.textContent).toContain('/context');
      expect(container.textContent).toContain('/model');
    });

    it('should render header with icon', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const header = container.querySelector('svg');
      expect(header).toBeTruthy();
    });

    it('should render footer with keyboard hints', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(container.textContent).toContain('navigate');
      expect(container.textContent).toContain('select');
      expect(container.textContent).toContain('close');
    });
  });

  describe('Selection Highlighting', () => {
    it('should highlight selected command', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const buttons = container.querySelectorAll('button');
      const commandButtons = Array.from(buttons).filter((btn) => btn.textContent?.startsWith('/'));
      expect(commandButtons[0].className).toContain('bg-accent/20');
      expect(commandButtons[0].className).toContain('border-l-2');
      expect(commandButtons[0].className).toContain('border-accent');
    });

    it('should highlight correct command based on selectedIndex', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={2}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const buttons = container.querySelectorAll('button');
      const commandButtons = Array.from(buttons).filter((btn) => btn.textContent?.startsWith('/'));

      expect(commandButtons[2].className).toContain('bg-accent/20');

      expect(commandButtons[0].className).not.toContain('bg-accent/20');
      expect(commandButtons[1].className).not.toContain('bg-accent/20');
    });

    it('should update highlight when selectedIndex changes', () => {
      const { container, rerender } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      rerender(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={3}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const buttons = container.querySelectorAll('button');
      const commandButtons = Array.from(buttons).filter((btn) => btn.textContent?.startsWith('/'));

      expect(commandButtons[3].className).toContain('bg-accent/20');
    });
  });

  describe('Command Selection', () => {
    it('should call onSelect with command when clicked', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const buttons = container.querySelectorAll('button');
      const commandButtons = Array.from(buttons).filter((btn) => btn.textContent?.startsWith('/'));

      fireEvent.click(commandButtons[1]);

      expect(mockOnSelect).toHaveBeenCalledWith('/clear');
    });

    it('should call onSelect for any command', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const buttons = container.querySelectorAll('button');
      const commandButtons = Array.from(buttons).filter((btn) => btn.textContent?.startsWith('/'));

      fireEvent.click(commandButtons[4]);

      expect(mockOnSelect).toHaveBeenCalledWith('/model');
    });
  });

  describe('Close on Click Outside', () => {
    it('should call onClose when clicking outside', () => {
      render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      fireEvent.mouseDown(document);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should not call onClose when clicking inside dropdown', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const dropdown = container.firstElementChild!;
      fireEvent.mouseDown(dropdown);

      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it('should call onClose when touching outside (touchend)', () => {
      const { container } = render(
        <div>
          <CommandAutocomplete
            commands={mockCommands}
            selectedIndex={0}
            onSelect={mockOnSelect}
            onClose={mockOnClose}
          />
          <div data-testid="outside">Outside</div>
        </div>
      );

      const outside = container.querySelector('[data-testid="outside"]')!;
      fireEvent.touchEnd(outside);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should not call onClose when touching inside dropdown (touchend)', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const dropdown = container.firstElementChild!;
      fireEvent.touchEnd(dropdown);

      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });

  describe('Positioning', () => {
    it('should use default positioning when position prop not provided', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const dropdown = container.firstElementChild as HTMLElement;
      expect(dropdown.style.bottom).toBe('100%');
      expect(dropdown.style.marginBottom).toBe('8px');
    });

    it('should use custom positioning when position prop is provided', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          position={{ top: 100, left: 50 }}
        />
      );

      const dropdown = container.firstElementChild as HTMLElement;
      expect(dropdown.style.top).toBe('100px');
      expect(dropdown.style.left).toBe('50px');
    });
  });

  describe('Styling', () => {
    it('should have dropdown container styling', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const dropdown = container.firstElementChild!;
      expect(dropdown.className).toContain('absolute');
      expect(dropdown.className).toContain('z-50');
      expect(dropdown.className).toContain('bg-surface-raised');
      expect(dropdown.className).toContain('rounded-lg');
      expect(dropdown.className).toContain('shadow-xl');
    });

    it('should have max height with overflow scroll', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const dropdown = container.firstElementChild!;
      expect(dropdown.className).toContain('max-h-64');
      expect(dropdown.className).toContain('overflow-y-auto');
    });

    it('should have animation class', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const dropdown = container.firstElementChild!;
      expect(dropdown.className).toContain('animate-slideIn');
    });

    it('should have min and max width constraints', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const dropdown = container.firstElementChild as HTMLElement;
      expect(dropdown.style.minWidth).toBe('250px');
      expect(dropdown.style.maxWidth).toBe('400px');
    });
  });

  describe('Command Item Styling', () => {
    it('should have hover styling on command items', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const buttons = container.querySelectorAll('button');
      const commandButtons = Array.from(buttons).filter((btn) => btn.textContent?.startsWith('/'));

      expect(commandButtons[0].className).toContain('hover:bg-fill-strong/50');
    });

    it('should have blue text for commands', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const commandText = container.querySelector('.text-accent');
      expect(commandText).toBeTruthy();
    });

    it('should have monospace font for commands', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const commandText = container.querySelector('.font-mono');
      expect(commandText).toBeTruthy();
    });
  });

  describe('Keyboard Hints', () => {
    it('should show up/down arrow hint', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const footer = container.querySelector('.border-t');
      expect(footer?.textContent).toContain('navigate');
    });

    it('should show Enter hint', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const footer = container.querySelector('.border-t');
      expect(footer?.textContent).toContain('Enter');
      expect(footer?.textContent).toContain('select');
    });

    it('should show Esc hint', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const footer = container.querySelector('.border-t');
      expect(footer?.textContent).toContain('Esc');
      expect(footer?.textContent).toContain('close');
    });

    it('should style keyboard hints as kbd elements', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const kbdElements = container.querySelectorAll('kbd');
      expect(kbdElements.length).toBe(3);
    });
  });

  describe('Single Command', () => {
    it('should render single command correctly', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={['/help']}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(container.textContent).toContain('/help');
    });

    it('should highlight single command when selected', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={['/help']}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const buttons = container.querySelectorAll('button');
      const commandButton = Array.from(buttons).find((btn) => btn.textContent?.includes('/help'))!;

      expect(commandButton.className).toContain('bg-accent/20');
    });
  });

  describe('Many Commands', () => {
    it('should handle many commands with scrolling', () => {
      const manyCommands = Array.from({ length: 20 }, (_, i) => `/command${i}`);

      const { container } = render(
        <CommandAutocomplete
          commands={manyCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(container.textContent).toContain('/command0');
      expect(container.textContent).toContain('/command19');
    });
  });

  describe('Button Type', () => {
    it('should have type="button" on command buttons', () => {
      const { container } = render(
        <CommandAutocomplete
          commands={mockCommands}
          selectedIndex={0}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const buttons = container.querySelectorAll('button');
      const commandButtons = Array.from(buttons).filter((btn) => btn.textContent?.startsWith('/'));

      for (const button of commandButtons) {
        expect((button as HTMLButtonElement).type).toBe('button');
      }
    });
  });
});
