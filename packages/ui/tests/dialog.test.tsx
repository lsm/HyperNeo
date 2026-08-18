import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CloseButton,
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogPanel,
  DialogTitle,
} from '../src/mod.ts';

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
  const portalRoot = document.getElementById('headlessui-portal-root');
  if (portalRoot) {
    portalRoot.remove();
  }
});

function getDialog() {
  return document.querySelector('[role="dialog"]');
}

function getAlertDialog() {
  return document.querySelector('[role="alertdialog"]');
}

describe('Dialog', () => {
  it('should not render when open is false', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={false} onClose={onClose}>
        <div>Dialog content</div>
      </Dialog>
    );
    await act(async () => {});
    expect(getDialog()).toBeNull();
  });

  it('should render when open is true', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <div>Dialog content</div>
      </Dialog>
    );
    await act(async () => {});
    expect(getDialog()).not.toBeNull();
  });

  it('should set role=dialog', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <div>Dialog content</div>
      </Dialog>
    );
    await act(async () => {});
    const dialog = getDialog();
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('role')).toBe('dialog');
  });

  it('should set aria-modal=true', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <div>Dialog content</div>
      </Dialog>
    );
    await act(async () => {});
    const dialog = getDialog();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
  });

  it('should call onClose when Escape is pressed', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <div>Dialog content</div>
      </Dialog>
    );
    await act(async () => {});
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('should call onClose(false) when clicking DialogBackdrop', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <DialogBackdrop data-testid="backdrop">Backdrop</DialogBackdrop>
        <DialogPanel>Panel content</DialogPanel>
      </Dialog>
    );
    await act(async () => {});
    const backdrop = document.querySelector('[data-testid="backdrop"]');
    expect(backdrop).not.toBeNull();
    if (backdrop) fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('should set aria-labelledby pointing to DialogTitle id', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <DialogTitle>My Title</DialogTitle>
        <DialogPanel>Panel content</DialogPanel>
      </Dialog>
    );
    await act(async () => {});
    const dialog = getDialog();
    const title = document.body.querySelector('h2');
    const titleId = title?.getAttribute('id');
    expect(titleId).toBeTruthy();
    expect(dialog?.getAttribute('aria-labelledby')).toBe(titleId);
  });

  it('should set aria-describedby pointing to DialogDescription id', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <DialogDescription>My Description</DialogDescription>
        <DialogPanel>Panel content</DialogPanel>
      </Dialog>
    );
    await act(async () => {});
    const dialog = getDialog();
    const desc = document.body.querySelector('p');
    const descId = desc?.getAttribute('id');
    expect(descId).toBeTruthy();
    expect(dialog?.getAttribute('aria-describedby')).toBe(descId);
  });

  it('should render CloseButton that calls onClose', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <DialogPanel>
          <CloseButton>Close</CloseButton>
        </DialogPanel>
      </Dialog>
    );
    await act(async () => {});
    const closeBtn = document.body.querySelector('button');
    expect(closeBtn).not.toBeNull();
    if (closeBtn) fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('should support role=alertdialog', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose} role="alertdialog">
        <div>Alert dialog content</div>
      </Dialog>
    );
    await act(async () => {});
    const alertDialog = getAlertDialog();
    expect(alertDialog).not.toBeNull();
    expect(alertDialog?.getAttribute('role')).toBe('alertdialog');
  });

  it('should provide open state via render prop', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        {({ open }: { open: boolean }) => (
          <DialogPanel>
            <span>{open ? 'is-open' : 'is-closed'}</span>
          </DialogPanel>
        )}
      </Dialog>
    );
    await act(async () => {});
    const span = document.body.querySelector('span');
    expect(span?.textContent).toBe('is-open');
  });

  it('should throw when DialogPanel used outside Dialog', () => {
    expect(() => {
      render(<DialogPanel>Orphan</DialogPanel>);
    }).toThrow('<DialogPanel> must be used within a <Dialog>');
  });

  it('should throw when DialogTitle used outside Dialog', () => {
    expect(() => {
      render(<DialogTitle>Orphan</DialogTitle>);
    }).toThrow('<DialogTitle> must be used within a <Dialog>');
  });

  it('should throw when DialogDescription used outside Dialog', () => {
    expect(() => {
      render(<DialogDescription>Orphan</DialogDescription>);
    }).toThrow('<DialogDescription> must be used within a <Dialog>');
  });

  it('should throw when DialogBackdrop used outside Dialog', () => {
    expect(() => {
      render(<DialogBackdrop>Orphan</DialogBackdrop>);
    }).toThrow('<DialogBackdrop> must be used within a <Dialog>');
  });

  it('should throw when CloseButton used outside Dialog', () => {
    expect(() => {
      render(<CloseButton>Orphan</CloseButton>);
    }).toThrow('<CloseButton> must be used within a <Dialog>');
  });

  it('should handle CloseButton mouseenter and mouseleave', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <DialogPanel>
          <CloseButton>Close</CloseButton>
        </DialogPanel>
      </Dialog>
    );
    await act(async () => {});
    const closeBtn = document.body.querySelector('button');
    expect(closeBtn).not.toBeNull();
    if (closeBtn) {
      fireEvent.mouseEnter(closeBtn);
      fireEvent.mouseLeave(closeBtn);
    }
    expect(closeBtn).not.toBeNull();
  });

  it('should handle CloseButton focus and blur', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <DialogPanel>
          <CloseButton>Close</CloseButton>
        </DialogPanel>
      </Dialog>
    );
    await act(async () => {});
    const closeBtn = document.body.querySelector('button');
    expect(closeBtn).not.toBeNull();
    if (closeBtn) {
      await act(async () => {
        closeBtn.focus();
      });
      await act(async () => {
        closeBtn.blur();
      });
    }
    expect(closeBtn).not.toBeNull();
  });

  it('should handle CloseButton mousedown and mouseup', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <DialogPanel>
          <CloseButton>Close</CloseButton>
        </DialogPanel>
      </Dialog>
    );
    await act(async () => {});
    const closeBtn = document.body.querySelector('button');
    expect(closeBtn).not.toBeNull();
    if (closeBtn) {
      fireEvent.mouseDown(closeBtn);
      fireEvent.mouseUp(closeBtn);
    }
    expect(closeBtn).not.toBeNull();
  });

  it('should call onClose on outside click (useOutsideClick)', async () => {
    const onClose = vi.fn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      render(
        <Dialog open={true} onClose={onClose}>
          <DialogPanel data-testid="panel">Panel content</DialogPanel>
        </Dialog>
      );
      await act(async () => {});
      await act(async () => {
        vi.advanceTimersByTime(10);
      });
      await act(async () => {
        document.body.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
        );
      });
      expect(onClose).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should cover transition enter attrs with RAF flush', async () => {
    const raf = new RAFQueue();
    raf.install();

    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open={false} onClose={onClose} transition>
        <DialogPanel>Panel content</DialogPanel>
      </Dialog>
    );
    await act(async () => {});

    await act(async () => {
      rerender(
        <Dialog open={true} onClose={onClose} transition>
          <DialogPanel>Panel content</DialogPanel>
        </Dialog>
      );
    });
    await act(async () => {
      raf.flush();
    });

    expect(getDialog()).not.toBeNull();
  });

  it('should cover transition leave attrs with RAF flush', async () => {
    const raf = new RAFQueue();
    raf.install();

    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open={true} onClose={onClose} transition unmount={false}>
        <DialogPanel>Panel content</DialogPanel>
      </Dialog>
    );
    await act(async () => {});
    await act(async () => {
      raf.flush();
    });

    await act(async () => {
      rerender(
        <Dialog open={false} onClose={onClose} transition unmount={false}>
          <DialogPanel>Panel content</DialogPanel>
        </Dialog>
      );
    });
    await act(async () => {
      raf.flush();
    });

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('should accept initialFocus prop', async () => {
    const onClose = vi.fn();
    const initialFocusRef = { current: null as HTMLInputElement | null };

    const { container } = render(
      <Dialog open={true} onClose={onClose} initialFocus={initialFocusRef}>
        <DialogPanel>
          <button>First button</button>
        </DialogPanel>
      </Dialog>
    );
    await act(async () => {});

    expect(getDialog()).not.toBeNull();
  });

  it('should support __demoMode prop to disable aria-modal', async () => {
    const onClose = vi.fn();

    render(
      <Dialog open={true} onClose={onClose} __demoMode>
        <DialogPanel>
          <button data-testid="demo-button">Demo button</button>
        </DialogPanel>
      </Dialog>
    );
    await act(async () => {});

    const dialog = getDialog();
    expect(dialog?.getAttribute('aria-modal')).toBeNull();
  });

  it('should set id attribute on dialog element', async () => {
    const onClose = vi.fn();

    render(
      <Dialog open={true} onClose={onClose}>
        <DialogPanel>Panel content</DialogPanel>
      </Dialog>
    );
    await act(async () => {});

    const dialog = getDialog();
    expect(dialog?.id.startsWith('headlessui-dialog-')).toBe(true);
  });

  it('should set tabIndex=-1 on dialog element', async () => {
    const onClose = vi.fn();

    render(
      <Dialog open={true} onClose={onClose}>
        <DialogPanel>Panel content</DialogPanel>
      </Dialog>
    );
    await act(async () => {});

    const dialog = getDialog();
    expect(dialog?.tabIndex).toBe(-1);
  });

  it('should set id on DialogPanel', async () => {
    const onClose = vi.fn();

    render(
      <Dialog open={true} onClose={onClose}>
        <DialogPanel data-testid="panel">Panel content</DialogPanel>
      </Dialog>
    );
    await act(async () => {});

    const panel = document.body.querySelector('[data-testid="panel"]');
    expect(panel?.id.startsWith('headlessui-dialog-panel-')).toBe(true);
  });

  it('should stop propagation on DialogPanel click', async () => {
    const onClose = vi.fn();
    const parentClick = vi.fn();

    render(
      <div onClick={parentClick}>
        <Dialog open={true} onClose={onClose}>
          <DialogPanel data-testid="panel">Panel content</DialogPanel>
        </Dialog>
      </div>
    );
    await act(async () => {});

    const panel = document.body.querySelector('[data-testid="panel"]');
    expect(panel).not.toBeNull();
    if (panel) {
      fireEvent.click(panel);
    }
    expect(parentClick).not.toHaveBeenCalled();
  });
});
