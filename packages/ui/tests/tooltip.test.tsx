import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tooltip, TooltipPanel, TooltipTrigger } from '../src/mod.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function BasicTooltip({
  showDelay = 500,
  hideDelay = 0,
  staticPanel = false,
}: {
  showDelay?: number;
  hideDelay?: number;
  staticPanel?: boolean;
}) {
  return (
    <Tooltip showDelay={showDelay} hideDelay={hideDelay}>
      <TooltipTrigger data-testid="trigger">Hover me</TooltipTrigger>
      <TooltipPanel data-testid="panel" static={staticPanel}>
        Tooltip content
      </TooltipPanel>
    </Tooltip>
  );
}

describe('Tooltip', () => {
  describe('basic rendering', () => {
    it('renders the trigger', () => {
      render(<BasicTooltip />);
      expect(screen.getByTestId('trigger')).not.toBeNull();
    });

    it('panel is hidden by default (unmounts when closed)', () => {
      render(<BasicTooltip />);
      expect(screen.queryByTestId('panel')).toBeNull();
    });

    it('panel has role="tooltip" when visible', async () => {
      vi.useFakeTimers();
      render(<BasicTooltip showDelay={0} />);
      const trigger = screen.getByTestId('trigger');
      await act(async () => {
        fireEvent.mouseEnter(trigger);
      });
      const panel = screen.queryByTestId('panel');
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute('role')).toBe('tooltip');
    });
  });

  describe('showDelay and opening', () => {
    it('shows panel after showDelay on mouseenter', async () => {
      vi.useFakeTimers();
      render(<BasicTooltip showDelay={500} />);
      const trigger = screen.getByTestId('trigger');

      await act(async () => {
        fireEvent.mouseEnter(trigger);
      });
      expect(screen.queryByTestId('panel')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.queryByTestId('panel')).not.toBeNull();
    });

    it('shows immediately when showDelay=0', async () => {
      vi.useFakeTimers();
      render(<BasicTooltip showDelay={0} />);
      const trigger = screen.getByTestId('trigger');

      await act(async () => {
        fireEvent.mouseEnter(trigger);
      });
      expect(screen.queryByTestId('panel')).not.toBeNull();
    });

    it('shows panel on focus', async () => {
      vi.useFakeTimers();
      render(<BasicTooltip showDelay={0} />);
      const trigger = screen.getByTestId('trigger');

      await act(async () => {
        trigger.focus();
      });
      expect(screen.queryByTestId('panel')).not.toBeNull();
    });
  });

  describe('hideDelay and hiding', () => {
    it('hides panel on mouseleave (hideDelay=0)', async () => {
      vi.useFakeTimers();
      render(<BasicTooltip showDelay={0} hideDelay={0} />);
      const trigger = screen.getByTestId('trigger');

      await act(async () => {
        fireEvent.mouseEnter(trigger);
      });
      expect(screen.queryByTestId('panel')).not.toBeNull();

      await act(async () => {
        fireEvent.mouseLeave(trigger);
      });
      expect(screen.queryByTestId('panel')).toBeNull();
    });

    it('hides panel on blur', async () => {
      vi.useFakeTimers();
      render(<BasicTooltip showDelay={0} hideDelay={0} />);
      const trigger = screen.getByTestId('trigger');

      await act(async () => {
        trigger.focus();
      });
      expect(screen.queryByTestId('panel')).not.toBeNull();

      await act(async () => {
        trigger.blur();
      });
      expect(screen.queryByTestId('panel')).toBeNull();
    });

    it('hides after hideDelay when hideDelay > 0', async () => {
      vi.useFakeTimers();
      render(<BasicTooltip showDelay={0} hideDelay={300} />);
      const trigger = screen.getByTestId('trigger');

      await act(async () => {
        fireEvent.mouseEnter(trigger);
      });
      expect(screen.queryByTestId('panel')).not.toBeNull();

      await act(async () => {
        fireEvent.mouseLeave(trigger);
      });
      expect(screen.queryByTestId('panel')).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.queryByTestId('panel')).toBeNull();
    });
  });

  describe('Escape key', () => {
    it('hides panel on Escape key when open', async () => {
      vi.useFakeTimers();
      render(<BasicTooltip showDelay={0} hideDelay={0} />);
      const trigger = screen.getByTestId('trigger');

      await act(async () => {
        fireEvent.mouseEnter(trigger);
      });
      expect(screen.queryByTestId('panel')).not.toBeNull();

      await act(async () => {
        fireEvent.keyDown(trigger, { key: 'Escape' });
      });
      expect(screen.queryByTestId('panel')).toBeNull();
    });

    it('does not error on Escape key when already closed', async () => {
      render(<BasicTooltip />);
      const trigger = screen.getByTestId('trigger');
      await act(async () => {
        fireEvent.keyDown(trigger, { key: 'Escape' });
      });
      expect(screen.queryByTestId('panel')).toBeNull();
    });
  });

  describe('aria attributes', () => {
    it('aria-describedby on trigger points to panel id when open', async () => {
      vi.useFakeTimers();
      render(<BasicTooltip showDelay={0} />);
      const trigger = screen.getByTestId('trigger');

      await act(async () => {
        fireEvent.mouseEnter(trigger);
      });

      const panel = screen.queryByTestId('panel');
      expect(panel).not.toBeNull();
      const panelId = panel?.getAttribute('id');
      expect(panelId).toBeTruthy();
      expect(trigger.getAttribute('aria-describedby')).toBe(panelId);
    });

    it('aria-describedby is not set on trigger when closed', () => {
      render(<BasicTooltip />);
      const trigger = screen.getByTestId('trigger');
      expect(trigger.getAttribute('aria-describedby')).toBeNull();
    });
  });

  describe('data-open / data-closed attributes', () => {
    it('trigger has data-closed when not open', () => {
      render(<BasicTooltip />);
      const trigger = screen.getByTestId('trigger');
      expect(trigger.getAttribute('data-closed')).toBe('');
      expect(trigger.getAttribute('data-open')).toBeNull();
    });

    it('trigger has data-open when open', async () => {
      vi.useFakeTimers();
      render(<BasicTooltip showDelay={0} />);
      const trigger = screen.getByTestId('trigger');

      await act(async () => {
        fireEvent.mouseEnter(trigger);
      });

      expect(trigger.getAttribute('data-open')).toBe('');
      expect(trigger.getAttribute('data-closed')).toBeNull();
    });

    it('panel has data-open when visible', async () => {
      vi.useFakeTimers();
      render(<BasicTooltip showDelay={0} />);
      const trigger = screen.getByTestId('trigger');

      await act(async () => {
        fireEvent.mouseEnter(trigger);
      });

      const panel = screen.queryByTestId('panel');
      expect(panel?.getAttribute('data-open')).toBe('');
    });
  });

  describe('static prop', () => {
    it('static panel stays in DOM even when closed', () => {
      render(<BasicTooltip staticPanel />);
      expect(screen.queryByTestId('panel')).not.toBeNull();
    });

    it('static panel has data-closed when not open', () => {
      render(<BasicTooltip staticPanel />);
      const panel = screen.getByTestId('panel');
      expect(panel.getAttribute('data-closed')).toBe('');
    });
  });

  describe('polymorphic as prop', () => {
    it('TooltipTrigger renders as custom element (span)', async () => {
      render(
        <Tooltip showDelay={0}>
          <TooltipTrigger as="span" data-testid="trigger">
            Trigger
          </TooltipTrigger>
          <TooltipPanel data-testid="panel">Panel</TooltipPanel>
        </Tooltip>
      );
      const trigger = screen.getByTestId('trigger');
      expect(trigger.tagName.toLowerCase()).toBe('span');
    });

    it('TooltipPanel renders as custom element (span)', async () => {
      vi.useFakeTimers();
      render(
        <Tooltip showDelay={0}>
          <TooltipTrigger data-testid="trigger">Trigger</TooltipTrigger>
          <TooltipPanel as="span" data-testid="panel">
            Panel
          </TooltipPanel>
        </Tooltip>
      );
      const trigger = screen.getByTestId('trigger');
      await act(async () => {
        fireEvent.mouseEnter(trigger);
      });
      const panel = screen.queryByTestId('panel');
      expect(panel?.tagName.toLowerCase()).toBe('span');
    });

    it('Tooltip renders as custom element (nav)', () => {
      const { container } = render(
        <Tooltip as="nav">
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipPanel>Panel</TooltipPanel>
        </Tooltip>
      );
      expect(container.querySelector('nav')).not.toBeNull();
    });
  });

  describe('render props', () => {
    it('Tooltip children render prop exposes {open} boolean', async () => {
      vi.useFakeTimers();
      render(
        <Tooltip showDelay={0}>
          {({ open }: { open: boolean }) => (
            <>
              <TooltipTrigger data-testid="trigger">
                {open ? 'is-open' : 'is-closed'}
              </TooltipTrigger>
              <TooltipPanel>Panel</TooltipPanel>
            </>
          )}
        </Tooltip>
      );

      expect(screen.getByTestId('trigger').textContent).toBe('is-closed');

      await act(async () => {
        fireEvent.mouseEnter(screen.getByTestId('trigger'));
      });

      expect(screen.getByTestId('trigger').textContent).toBe('is-open');
    });
  });

  describe('error handling', () => {
    it('throws when TooltipTrigger used outside Tooltip', () => {
      expect(() => {
        render(<TooltipTrigger>Orphan</TooltipTrigger>);
      }).toThrow('<TooltipTrigger> must be used within a <Tooltip>');
    });

    it('throws when TooltipPanel used outside Tooltip', () => {
      expect(() => {
        render(<TooltipPanel>Orphan</TooltipPanel>);
      }).toThrow('<TooltipPanel> must be used within a <Tooltip>');
    });
  });

  describe('disabled trigger', () => {
    it('does not show panel when trigger is disabled and mouseenter fires', async () => {
      vi.useFakeTimers();
      render(
        <Tooltip showDelay={0}>
          <TooltipTrigger disabled data-testid="trigger">
            Disabled
          </TooltipTrigger>
          <TooltipPanel data-testid="panel">Panel</TooltipPanel>
        </Tooltip>
      );
      const trigger = screen.getByTestId('trigger');
      await act(async () => {
        fireEvent.mouseEnter(trigger);
      });
      expect(screen.queryByTestId('panel')).toBeNull();
    });

    it('does not show panel when trigger is disabled and focus fires (span trigger)', async () => {
      vi.useFakeTimers();
      render(
        <Tooltip showDelay={0}>
          <TooltipTrigger as="span" disabled data-testid="trigger" tabIndex={0}>
            Disabled
          </TooltipTrigger>
          <TooltipPanel data-testid="panel">Panel</TooltipPanel>
        </Tooltip>
      );
      const trigger = screen.getByTestId('trigger');
      await act(async () => {
        trigger.focus();
      });
      expect(screen.queryByTestId('panel')).toBeNull();
    });
  });

  describe('custom showDelay', () => {
    it('does not show before delay expires', async () => {
      vi.useFakeTimers();
      render(<BasicTooltip showDelay={1000} />);
      const trigger = screen.getByTestId('trigger');

      await act(async () => {
        fireEvent.mouseEnter(trigger);
      });
      await act(async () => {
        vi.advanceTimersByTime(999);
      });
      expect(screen.queryByTestId('panel')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByTestId('panel')).not.toBeNull();
    });
  });

  describe('timer clearing', () => {
    it('cancels pending show timer on mouseleave before delay', async () => {
      vi.useFakeTimers();
      render(<BasicTooltip showDelay={500} hideDelay={0} />);
      const trigger = screen.getByTestId('trigger');

      await act(async () => {
        fireEvent.mouseEnter(trigger);
      });
      await act(async () => {
        fireEvent.mouseLeave(trigger);
      });
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.queryByTestId('panel')).toBeNull();
    });
  });

  describe('unmount=false', () => {
    it('panel stays in DOM with unmount=false when closed', () => {
      render(
        <Tooltip showDelay={0}>
          <TooltipTrigger data-testid="trigger">Trigger</TooltipTrigger>
          <TooltipPanel unmount={false} data-testid="panel">
            Panel
          </TooltipPanel>
        </Tooltip>
      );
      expect(screen.queryByTestId('panel')).not.toBeNull();
    });
  });
});
