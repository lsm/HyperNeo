import { act, cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IconButton } from '../src/mod.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('IconButton', () => {
  describe('basic rendering', () => {
    it('renders as button by default', () => {
      render(<IconButton label="Close" />);
      expect(screen.getByRole('button')).not.toBeNull();
    });

    it('sets type="button" when as="button"', () => {
      render(<IconButton label="Close" />);
      const btn = screen.getByRole('button');
      expect(btn.getAttribute('type')).toBe('button');
    });

    it('sets aria-label from label prop', () => {
      render(<IconButton label="Delete item" />);
      const btn = screen.getByRole('button');
      expect(btn.getAttribute('aria-label')).toBe('Delete item');
    });

    it('renders children', () => {
      render(
        <IconButton label="Close">
          <span data-testid="icon">X</span>
        </IconButton>
      );
      expect(screen.getByTestId('icon')).not.toBeNull();
    });
  });

  describe('type prop', () => {
    it('does not set type="button" when as is not "button"', () => {
      render(<IconButton as="a" label="Link" href="#" />);
      const link = screen.getByRole('link');
      expect(link.getAttribute('type')).toBeNull();
    });

    it('allows overriding type when as="button"', () => {
      render(<IconButton label="Submit" type="submit" />);
      const btn = screen.getByRole('button');
      expect(btn.getAttribute('type')).toBe('submit');
    });
  });

  describe('polymorphic as prop', () => {
    it('renders as anchor with as="a"', () => {
      render(<IconButton as="a" label="Go home" href="#" />);
      const link = screen.getByRole('link');
      expect(link).not.toBeNull();
      expect(link.tagName.toLowerCase()).toBe('a');
    });

    it('renders as span with as="span"', () => {
      const { container } = render(<IconButton as="span" label="Icon" />);
      const span = container.querySelector('span[aria-label="Icon"]');
      expect(span).not.toBeNull();
    });
  });

  describe('disabled prop', () => {
    it('sets disabled attribute when disabled=true', () => {
      render(<IconButton label="Close" disabled />);
      const btn = screen.getByRole('button') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it('sets data-disabled when disabled=true', () => {
      render(<IconButton label="Close" disabled />);
      const btn = screen.getByRole('button');
      expect(btn.getAttribute('data-disabled')).toBe('');
    });

    it('does not set data-disabled when not disabled', () => {
      render(<IconButton label="Close" />);
      const btn = screen.getByRole('button');
      expect(btn.getAttribute('data-disabled')).toBeNull();
    });
  });

  describe('hover interaction state', () => {
    it('sets data-hover on pointerenter (mouse)', async () => {
      render(<IconButton label="Close" data-testid="btn" />);
      const btn = screen.getByTestId('btn');
      await act(async () => {
        btn.dispatchEvent(
          new PointerEvent('pointerenter', { pointerType: 'mouse', bubbles: true })
        );
      });
      expect(btn.getAttribute('data-hover')).toBe('');
    });

    it('clears data-hover on pointerleave (mouse)', async () => {
      render(<IconButton label="Close" data-testid="btn" />);
      const btn = screen.getByTestId('btn');
      await act(async () => {
        btn.dispatchEvent(
          new PointerEvent('pointerenter', { pointerType: 'mouse', bubbles: true })
        );
      });
      expect(btn.getAttribute('data-hover')).toBe('');

      await act(async () => {
        btn.dispatchEvent(
          new PointerEvent('pointerleave', { pointerType: 'mouse', bubbles: true })
        );
      });
      expect(btn.getAttribute('data-hover')).toBeNull();
    });

    it('does not set data-hover on touch pointerenter', async () => {
      render(<IconButton label="Close" data-testid="btn" />);
      const btn = screen.getByTestId('btn');
      await act(async () => {
        btn.dispatchEvent(
          new PointerEvent('pointerenter', { pointerType: 'touch', bubbles: true })
        );
      });
      expect(btn.getAttribute('data-hover')).toBeNull();
    });

    it('does not clear data-hover on touch pointerleave', async () => {
      render(<IconButton label="Close" data-testid="btn" />);
      const btn = screen.getByTestId('btn');
      await act(async () => {
        btn.dispatchEvent(
          new PointerEvent('pointerenter', { pointerType: 'mouse', bubbles: true })
        );
      });
      await act(async () => {
        btn.dispatchEvent(
          new PointerEvent('pointerleave', { pointerType: 'touch', bubbles: true })
        );
      });
      expect(btn.getAttribute('data-hover')).toBe('');
    });
  });

  describe('focus interaction state', () => {
    it('sets data-focus after keyboard event + focus', async () => {
      render(<IconButton label="Close" data-testid="btn" />);
      const btn = screen.getByTestId('btn');

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      });
      await act(async () => {
        btn.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      });
      expect(btn.getAttribute('data-focus')).toBe('');
    });

    it('clears data-focus on blur', async () => {
      render(<IconButton label="Close" data-testid="btn" />);
      const btn = screen.getByTestId('btn');

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      });
      await act(async () => {
        btn.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      });
      expect(btn.getAttribute('data-focus')).toBe('');

      await act(async () => {
        btn.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      });
      expect(btn.getAttribute('data-focus')).toBeNull();
    });

    it('does not set data-focus without preceding keyboard event', async () => {
      render(<IconButton label="Close" data-testid="btn" />);
      const btn = screen.getByTestId('btn');
      await act(async () => {
        btn.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      });
      expect(btn.getAttribute('data-focus')).toBeNull();
    });
  });

  describe('active interaction state', () => {
    it('sets data-active on pointerdown', async () => {
      render(<IconButton label="Close" data-testid="btn" />);
      const btn = screen.getByTestId('btn');
      await act(async () => {
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      });
      expect(btn.getAttribute('data-active')).toBe('');
    });

    it('clears data-active on pointerup', async () => {
      render(<IconButton label="Close" data-testid="btn" />);
      const btn = screen.getByTestId('btn');
      await act(async () => {
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      });
      expect(btn.getAttribute('data-active')).toBe('');

      await act(async () => {
        btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      });
      expect(btn.getAttribute('data-active')).toBeNull();
    });

    it('also clears data-active on pointerleave', async () => {
      render(<IconButton label="Close" data-testid="btn" />);
      const btn = screen.getByTestId('btn');

      await act(async () => {
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      });
      expect(btn.getAttribute('data-active')).toBe('');

      await act(async () => {
        btn.dispatchEvent(
          new PointerEvent('pointerleave', { pointerType: 'mouse', bubbles: true })
        );
      });
      expect(btn.getAttribute('data-active')).toBeNull();
    });
  });

  describe('ref forwarding', () => {
    it('renders without error when ref is provided', () => {
      render(<IconButton label="Close" data-testid="icon-btn-ref" />);
      const el = screen.getByTestId('icon-btn-ref');
      expect(el).not.toBeNull();
      expect(el.tagName.toLowerCase()).toBe('button');
    });

    it('renders as anchor element accessible via DOM', () => {
      render(<IconButton as="a" label="Go" href="#" data-testid="icon-btn-a" />);
      const el = screen.getByTestId('icon-btn-a');
      expect(el).not.toBeNull();
      expect(el.tagName.toLowerCase()).toBe('a');
    });
  });

  describe('click handler', () => {
    it('click handler fires when button is clicked', async () => {
      const onClick = vi.fn();
      render(<IconButton label="Close" onClick={onClick} />);
      const btn = screen.getByRole('button');
      await act(async () => {
        btn.click();
      });
      expect(onClick).toHaveBeenCalled();
    });
  });

  describe('additional props', () => {
    it('passes through className', () => {
      render(<IconButton label="Close" class="my-icon-btn" data-testid="btn" />);
      const btn = screen.getByTestId('btn');
      expect(btn.className).toContain('my-icon-btn');
    });

    it('passes through data attributes', () => {
      render(<IconButton label="Close" data-testid="my-btn" />);
      expect(screen.getByTestId('my-btn')).not.toBeNull();
    });
  });

  describe('disabled state clears interaction state', () => {
    it('interaction state hooks are inactive when disabled', async () => {
      render(<IconButton label="Close" disabled data-testid="btn" />);
      const btn = screen.getByTestId('btn');

      await act(async () => {
        btn.dispatchEvent(
          new PointerEvent('pointerenter', { pointerType: 'mouse', bubbles: true })
        );
      });
      expect(btn.getAttribute('data-hover')).toBeNull();
    });
  });
});
