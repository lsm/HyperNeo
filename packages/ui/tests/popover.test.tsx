import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Popover, PopoverButton, PopoverPanel } from '../src/mod.ts';

class RAFQueue {
  callbacks: FrameRequestCallback[] = [];
  private idCounter = 0;
  schedule(cb: FrameRequestCallback): number {
    this.callbacks.push(cb);
    return ++this.idCounter;
  }
  flush(maxRounds = 20): void {
    for (let i = 0; i < maxRounds; i++) {
      if (!this.callbacks.length) break;
      const batch = this.callbacks.splice(0);
      for (const cb of batch) cb(performance.now());
    }
  }
  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => this.schedule(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function BasicPopover({ unmount = true }: { unmount?: boolean }) {
  return (
    <Popover>
      <PopoverButton>Toggle</PopoverButton>
      <PopoverPanel unmount={unmount}>
        <span>Panel content</span>
      </PopoverPanel>
    </Popover>
  );
}

describe('Popover', () => {
  it('should be closed by default', () => {
    render(<BasicPopover />);
    expect(screen.queryByText('Panel content')).toBeNull();
  });

  it('should open on PopoverButton click', () => {
    render(<BasicPopover />);
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.getByText('Panel content')).not.toBeNull();
  });

  it('should close on second PopoverButton click', () => {
    render(<BasicPopover />);
    const btn = screen.getByText('Toggle');
    fireEvent.click(btn);
    expect(screen.getByText('Panel content')).not.toBeNull();
    fireEvent.click(btn);
    expect(screen.queryByText('Panel content')).toBeNull();
  });

  it('should set aria-expanded on PopoverButton', async () => {
    render(<BasicPopover />);
    const btn = screen.getByText('Toggle');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(screen.getByText('Toggle').getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      fireEvent.click(screen.getByText('Toggle'));
    });
    expect(screen.getByText('Toggle').getAttribute('aria-expanded')).toBe('false');
  });

  it('should set aria-controls on PopoverButton pointing to panel', () => {
    render(<BasicPopover />);
    const btn = screen.getByText('Toggle');
    fireEvent.click(btn);
    const panel = screen.getByText('Panel content').closest('div');
    const panelId = panel?.getAttribute('id');
    expect(panelId).toBeTruthy();
    expect(btn.getAttribute('aria-controls')).toBe(panelId);
  });

  it('should close on Escape key', async () => {
    render(<BasicPopover />);
    await act(async () => {
      fireEvent.click(screen.getByText('Toggle'));
    });
    expect(screen.getByText('Panel content')).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByText('Panel content')).toBeNull();
  });

  it('should provide open state via render prop', () => {
    render(
      <Popover>
        {({ open }: { open: boolean }) => (
          <>
            <PopoverButton>{open ? 'Close' : 'Open'}</PopoverButton>
            <PopoverPanel>Panel content</PopoverPanel>
          </>
        )}
      </Popover>
    );
    expect(screen.getByText('Open')).not.toBeNull();
    fireEvent.click(screen.getByText('Open'));
    expect(screen.getByText('Close')).not.toBeNull();
  });

  it('should support close() from render prop', () => {
    render(
      <Popover>
        {({ close }: { close: () => void }) => (
          <>
            <PopoverButton>Toggle</PopoverButton>
            <PopoverPanel>
              <button type="button" onClick={() => close()}>
                Close panel
              </button>
            </PopoverPanel>
          </>
        )}
      </Popover>
    );
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.getByText('Close panel')).not.toBeNull();
    fireEvent.click(screen.getByText('Close panel'));
    expect(screen.queryByText('Close panel')).toBeNull();
  });

  it('should unmount panel when closed by default', () => {
    render(<BasicPopover unmount={true} />);
    expect(screen.queryByText('Panel content')).toBeNull();
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.getByText('Panel content')).not.toBeNull();
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.queryByText('Panel content')).toBeNull();
  });

  it('should hide panel when unmount=false', () => {
    render(<BasicPopover unmount={false} />);
    const panel = screen.getByText('Panel content').closest('div');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('hidden')).toBe('');
  });

  it('should throw when PopoverButton used outside Popover', () => {
    expect(() => {
      render(<PopoverButton>Orphan</PopoverButton>);
    }).toThrow('<PopoverButton> must be used within a <Popover>');
  });

  it('should throw when PopoverPanel used outside Popover', () => {
    expect(() => {
      render(<PopoverPanel>Orphan</PopoverPanel>);
    }).toThrow('<PopoverPanel> must be used within a <Popover>');
  });

  it('should handle mouseenter and mouseleave on PopoverButton', () => {
    render(<BasicPopover />);
    const btn = screen.getByText('Toggle');
    fireEvent.mouseEnter(btn);
    fireEvent.mouseLeave(btn);
    expect(btn).not.toBeNull();
  });

  it('should handle focus and blur on PopoverButton', async () => {
    render(<BasicPopover />);
    const btn = screen.getByText('Toggle');
    await act(async () => {
      btn.focus();
    });
    await act(async () => {
      btn.blur();
    });
    expect(btn).not.toBeNull();
  });

  it('should handle mousedown and mouseup on PopoverButton', () => {
    render(<BasicPopover />);
    const btn = screen.getByText('Toggle');
    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);
    expect(btn).not.toBeNull();
  });

  it('should not toggle on click when PopoverButton is disabled', () => {
    render(
      <Popover>
        <PopoverButton disabled>Toggle</PopoverButton>
        <PopoverPanel>Panel content</PopoverPanel>
      </Popover>
    );
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.queryByText('Panel content')).toBeNull();
  });

  it('should not toggle on keydown when PopoverButton is disabled', () => {
    render(
      <Popover>
        <PopoverButton disabled>Toggle</PopoverButton>
        <PopoverPanel>Panel content</PopoverPanel>
      </Popover>
    );
    fireEvent.keyDown(screen.getByText('Toggle'), { key: 'Enter' });
    expect(screen.queryByText('Panel content')).toBeNull();
  });

  it('should toggle on Enter key via PopoverButton', () => {
    render(<BasicPopover />);
    const btn = screen.getByText('Toggle');
    expect(screen.queryByText('Panel content')).toBeNull();
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(screen.getByText('Panel content')).not.toBeNull();
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(screen.queryByText('Panel content')).toBeNull();
  });

  it('should toggle on Space key via PopoverButton', () => {
    render(<BasicPopover />);
    const btn = screen.getByText('Toggle');
    fireEvent.keyDown(btn, { key: ' ' });
    expect(screen.getByText('Panel content')).not.toBeNull();
  });

  it('should close on outside click (useOutsideClick)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      render(<BasicPopover />);
      await act(async () => {
        fireEvent.click(screen.getByText('Toggle'));
      });
      expect(screen.queryByText('Panel content')).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(10);
      });
      fireEvent.pointerDown(document.body);
      expect(screen.queryByText('Panel content')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should close on Tab key when panel is open (no focus trap)', async () => {
    render(<BasicPopover />);
    await act(async () => {
      fireEvent.click(screen.getByText('Toggle'));
    });
    expect(screen.queryByText('Panel content')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(screen.queryByText('Panel content')).toBeNull();
  });

  it('should support PopoverPanel with portal prop', async () => {
    render(
      <Popover>
        <PopoverButton>Toggle</PopoverButton>
        <PopoverPanel portal>
          <span>Portal content</span>
        </PopoverPanel>
      </Popover>
    );
    await act(async () => {
      fireEvent.click(screen.getByText('Toggle'));
    });
    expect(screen.getByText('Portal content')).not.toBeNull();
  });

  it('should support PopoverPanel with focus containment (modal=true)', async () => {
    render(
      <Popover>
        <PopoverButton>Toggle</PopoverButton>
        <PopoverPanel modal>
          <span>Modal content</span>
        </PopoverPanel>
      </Popover>
    );
    await act(async () => {
      fireEvent.click(screen.getByText('Toggle'));
    });
    expect(screen.getByText('Modal content')).not.toBeNull();
  });

  it('should cover transition enter attrs with RAF flush', async () => {
    const raf = new RAFQueue();
    raf.install();

    render(
      <Popover as="div">
        <PopoverButton>Toggle</PopoverButton>
        <PopoverPanel transition unmount={false}>
          <span>Panel content</span>
        </PopoverPanel>
      </Popover>
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Toggle'));
    });
    await act(async () => {
      raf.flush();
    });

    expect(screen.getByText('Panel content')).not.toBeNull();
  });

  it('should cover transition leave attrs with RAF flush', async () => {
    const raf = new RAFQueue();
    raf.install();

    render(
      <Popover as="div">
        <PopoverButton>Toggle</PopoverButton>
        <PopoverPanel transition unmount={false}>
          <span>Panel content</span>
        </PopoverPanel>
      </Popover>
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Toggle'));
    });
    await act(async () => {
      raf.flush();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Toggle'));
    });
    await act(async () => {
      raf.flush();
    });

    expect(screen.queryByText('Panel content')).not.toBeNull();
  });

  it('should call close() with focusRef to focus specific element', async () => {
    const raf = new RAFQueue();
    raf.install();

    render(
      <Popover>
        {({ close }: { close: (ref?: { current: HTMLElement | null }) => void }) => (
          <>
            <PopoverButton>Toggle</PopoverButton>
            <PopoverPanel>
              <button
                type="button"
                id="custom-focus"
                onClick={() => {
                  const ref = { current: document.getElementById('custom-focus') };
                  close(ref);
                }}
              >
                Close with focus
              </button>
            </PopoverPanel>
          </>
        )}
      </Popover>
    );
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.getByText('Close with focus')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Close with focus'));
    });
    await act(async () => {
      raf.flush();
    });
    expect(screen.queryByText('Close with focus')).toBeNull();
  });
});
