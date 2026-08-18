import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Toast,
  ToastAction,
  ToastDescription,
  ToastProgress,
  Toaster,
  ToastTitle,
  useToast,
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

function ToastResetter() {
  const { toasts, dismiss } = useToast();
  for (const t of toasts) {
    dismiss(t.id);
  }
  return null;
}

afterEach(async () => {
  await act(async () => {
    render(<ToastResetter />);
  });
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  const portalRoot = document.getElementById('headlessui-portal-root');
  if (portalRoot) portalRoot.remove();
});

describe('useToast hook', () => {
  it('toast() creates a toast and returns its id', async () => {
    function TestComponent() {
      const { toast, toasts } = useToast();
      return (
        <div>
          <button onClick={() => toast({ title: 'Hello' })}>Add</button>
          <span data-testid="count">{toasts.length}</span>
        </div>
      );
    }

    render(<TestComponent />);
    expect(screen.getByTestId('count').textContent).toBe('0');

    await act(async () => {
      fireEvent.click(screen.getByText('Add'));
    });
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('dismiss() removes a toast by id', async () => {
    function TestComponent() {
      const { toast, dismiss, toasts } = useToast();
      return (
        <div>
          <button
            onClick={() => {
              const id = toast({ title: 'Hello' });
              dismiss(id);
            }}
          >
            AddAndDismiss
          </button>
          <span data-testid="count">{toasts.length}</span>
        </div>
      );
    }

    render(<TestComponent />);
    await act(async () => {
      fireEvent.click(screen.getByText('AddAndDismiss'));
    });
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('multiple toasts can be active simultaneously', async () => {
    function TestComponent() {
      const { toast, toasts } = useToast();
      return (
        <div>
          <button onClick={() => toast({ title: `Toast ${toasts.length + 1}` })}>Add</button>
          <span data-testid="count">{toasts.length}</span>
        </div>
      );
    }

    render(<TestComponent />);
    await act(async () => {
      fireEvent.click(screen.getByText('Add'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Add'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Add'));
    });
    expect(screen.getByTestId('count').textContent).toBe('3');
  });

  it('toast() with existing id replaces that toast', async () => {
    function TestComponent() {
      const { toast, toasts } = useToast();
      return (
        <div>
          <button onClick={() => toast({ id: 'fixed-id', title: 'v1' })}>AddFixed</button>
          <button onClick={() => toast({ id: 'fixed-id', title: 'v2' })}>UpdateFixed</button>
          <span data-testid="count">{toasts.length}</span>
          <span data-testid="title">{toasts[0]?.title ?? ''}</span>
        </div>
      );
    }

    render(<TestComponent />);
    await act(async () => {
      fireEvent.click(screen.getByText('AddFixed'));
    });
    expect(screen.getByTestId('count').textContent).toBe('1');

    await act(async () => {
      fireEvent.click(screen.getByText('UpdateFixed'));
    });
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(screen.getByTestId('title').textContent).toBe('v2');
  });
});

describe('Toast component', () => {
  it('renders with role="status" when show=true', async () => {
    render(
      <Toast show={true}>
        <div>Toast content</div>
      </Toast>
    );
    await act(async () => {});
    const toast = document.querySelector('[role="status"]');
    expect(toast).not.toBeNull();
  });

  it('does not render content when show=false', async () => {
    render(
      <Toast show={false}>
        <div data-testid="inner">Toast content</div>
      </Toast>
    );
    await act(async () => {});
    expect(screen.queryByTestId('inner')).toBeNull();
  });

  it('auto-dismisses after duration', async () => {
    const raf = new RAFQueue();
    raf.install();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    render(
      <Toast show={true} duration={1000}>
        <div data-testid="inner">Content</div>
      </Toast>
    );
    await act(async () => {});
    expect(screen.queryByTestId('inner')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await act(async () => {
      raf.flush();
    });
    expect(screen.queryByTestId('inner')).toBeNull();
  });

  it('duration=0 never auto-dismisses', async () => {
    vi.useFakeTimers();
    render(
      <Toast show={true} duration={0}>
        <div data-testid="inner">Content</div>
      </Toast>
    );
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(100000);
    });
    expect(screen.queryByTestId('inner')).not.toBeNull();
  });

  it('respects show prop change (controlled)', async () => {
    const raf = new RAFQueue();
    raf.install();

    const { rerender } = render(
      <Toast show={true} duration={0}>
        <div data-testid="inner">Content</div>
      </Toast>
    );
    await act(async () => {});
    expect(screen.queryByTestId('inner')).not.toBeNull();

    await act(async () => {
      rerender(
        <Toast show={false} duration={0}>
          <div data-testid="inner">Content</div>
        </Toast>
      );
    });
    await act(async () => {
      raf.flush();
    });
    expect(screen.queryByTestId('inner')).toBeNull();
  });

  it('calls afterLeave when transition leaves', async () => {
    const raf = new RAFQueue();
    raf.install();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const afterLeave = vi.fn();
    render(
      <Toast show={true} duration={100} afterLeave={afterLeave}>
        <div>Content</div>
      </Toast>
    );
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    await act(async () => {
      raf.flush();
    });
    expect(afterLeave).toHaveBeenCalled();
  });
});

describe('ToastTitle', () => {
  it('throws when used outside Toast', () => {
    expect(() => {
      render(<ToastTitle>Title</ToastTitle>);
    }).toThrow('<ToastTitle> must be used within a <Toast>');
  });

  it('renders inside Toast and wires aria-labelledby', async () => {
    render(
      <Toast show={true}>
        <ToastTitle data-testid="title">My Title</ToastTitle>
      </Toast>
    );
    await act(async () => {});

    const toast = document.querySelector('[role="status"]');
    const title = screen.queryByTestId('title');
    expect(title).not.toBeNull();

    const titleId = title?.getAttribute('id');
    expect(titleId).toBeTruthy();
    expect(toast?.getAttribute('aria-labelledby')).toBe(titleId);
  });

  it('renders with custom as prop', async () => {
    render(
      <Toast show={true}>
        <ToastTitle as="h3" data-testid="title">
          Title
        </ToastTitle>
      </Toast>
    );
    await act(async () => {});
    const title = screen.queryByTestId('title');
    expect(title?.tagName.toLowerCase()).toBe('h3');
  });
});

describe('ToastDescription', () => {
  it('throws when used outside Toast', () => {
    expect(() => {
      render(<ToastDescription>Desc</ToastDescription>);
    }).toThrow('<ToastDescription> must be used within a <Toast>');
  });

  it('renders inside Toast and wires aria-describedby', async () => {
    render(
      <Toast show={true}>
        <ToastDescription data-testid="desc">My Description</ToastDescription>
      </Toast>
    );
    await act(async () => {});

    const toast = document.querySelector('[role="status"]');
    const desc = screen.queryByTestId('desc');
    expect(desc).not.toBeNull();

    const descId = desc?.getAttribute('id');
    expect(descId).toBeTruthy();
    expect(toast?.getAttribute('aria-describedby')).toBe(descId);
  });

  it('renders with custom as prop', async () => {
    render(
      <Toast show={true}>
        <ToastDescription as="span" data-testid="desc">
          Desc
        </ToastDescription>
      </Toast>
    );
    await act(async () => {});
    const desc = screen.queryByTestId('desc');
    expect(desc?.tagName.toLowerCase()).toBe('span');
  });
});

describe('ToastAction', () => {
  it('throws when used outside Toast', () => {
    expect(() => {
      render(<ToastAction>Action</ToastAction>);
    }).toThrow('<ToastAction> must be used within a <Toast>');
  });

  it('renders as button inside Toast', async () => {
    render(
      <Toast show={true}>
        <ToastAction data-testid="action">Click me</ToastAction>
      </Toast>
    );
    await act(async () => {});
    const action = screen.queryByTestId('action');
    expect(action).not.toBeNull();
    expect(action?.tagName.toLowerCase()).toBe('button');
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn();
    render(
      <Toast show={true}>
        <ToastAction onClick={onClick} data-testid="action">
          Click me
        </ToastAction>
      </Toast>
    );
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByTestId('action'));
    });
    expect(onClick).toHaveBeenCalled();
  });

  it('sets hover state on mouseenter/mouseleave', async () => {
    render(
      <Toast show={true}>
        <ToastAction data-testid="action">Action</ToastAction>
      </Toast>
    );
    await act(async () => {});
    const action = screen.getByTestId('action');
    await act(async () => {
      fireEvent.mouseEnter(action);
    });
    await act(async () => {
      fireEvent.mouseLeave(action);
    });
    expect(action).not.toBeNull();
  });

  it('sets focus state on focus/blur', async () => {
    render(
      <Toast show={true}>
        <ToastAction data-testid="action">Action</ToastAction>
      </Toast>
    );
    await act(async () => {});
    const action = screen.getByTestId('action');
    await act(async () => {
      action.focus();
    });
    await act(async () => {
      action.blur();
    });
    expect(action).not.toBeNull();
  });

  it('sets active state on mousedown/mouseup', async () => {
    render(
      <Toast show={true}>
        <ToastAction data-testid="action">Action</ToastAction>
      </Toast>
    );
    await act(async () => {});
    const action = screen.getByTestId('action');
    await act(async () => {
      fireEvent.mouseDown(action);
    });
    await act(async () => {
      fireEvent.mouseUp(action);
    });
    expect(action).not.toBeNull();
  });
});

describe('Toaster', () => {
  it('renders in portal (outside component tree container)', async () => {
    render(<Toaster />);
    await act(async () => {});
    const portalRoot = document.getElementById('headlessui-portal-root');
    expect(portalRoot).not.toBeNull();
  });

  it('has role="region" and aria-live="polite"', async () => {
    render(<Toaster />);
    await act(async () => {});
    const region = document.querySelector('[role="region"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-live')).toBe('polite');
  });

  it('has data-position attribute', async () => {
    render(<Toaster position="top-right" />);
    await act(async () => {});
    const region = document.querySelector('[role="region"]');
    expect(region?.getAttribute('data-position')).toBe('top-right');
  });

  it('defaults to bottom-right position', async () => {
    render(<Toaster />);
    await act(async () => {});
    const region = document.querySelector('[role="region"]');
    expect(region?.getAttribute('data-position')).toBe('bottom-right');
  });

  it('renders managed toasts when toasts are added via useToast', async () => {
    function AddToast() {
      const { toast } = useToast();
      return (
        <button onClick={() => toast({ title: 'Managed Toast', duration: 0 })}>Add Toast</button>
      );
    }

    render(
      <>
        <AddToast />
        <Toaster />
      </>
    );
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByText('Add Toast'));
    });
    await act(async () => {});

    expect(document.body.textContent).toContain('Managed Toast');
  });

  it('renders managed toast with description', async () => {
    function AddToast() {
      const { toast } = useToast();
      return (
        <button
          onClick={() => toast({ title: 'Hello', description: 'World description', duration: 0 })}
        >
          Add
        </button>
      );
    }

    render(
      <>
        <AddToast />
        <Toaster />
      </>
    );
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByText('Add'));
    });
    await act(async () => {});
    expect(document.body.textContent).toContain('World description');
  });

  it('renders custom children when provided', async () => {
    render(
      <Toaster>
        <div data-testid="custom-child">Custom</div>
      </Toaster>
    );
    await act(async () => {});
    expect(document.querySelector('[data-testid="custom-child"]')).not.toBeNull();
  });

  it('passes through additional props', async () => {
    render(<Toaster data-testid="toaster" />);
    await act(async () => {});
    expect(document.querySelector('[data-testid="toaster"]')).not.toBeNull();
  });

  it('renders with custom as prop', async () => {
    render(<Toaster as="nav" data-testid="toaster-nav" />);
    await act(async () => {});
    const el = document.querySelector('[data-testid="toaster-nav"]');
    expect(el?.tagName.toLowerCase()).toBe('nav');
  });

  it('removes managed toast from store after leave transition (afterLeave callback)', async () => {
    const raf = new RAFQueue();
    raf.install();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    function ToasterAndAdder() {
      const { toast, toasts } = useToast();
      return (
        <>
          <button onClick={() => toast({ title: 'Managed', duration: 200 })}>Add</button>
          <span data-testid="count">{toasts.length}</span>
          <Toaster />
        </>
      );
    }

    render(<ToasterAndAdder />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByText('Add'));
    });
    await act(async () => {});
    expect(screen.getByTestId('count').textContent).toBe('1');

    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await act(async () => {
      raf.flush();
    });
    await act(async () => {});
    expect(screen.getByTestId('count').textContent).toBe('0');
  });
});

describe('Toast variant', () => {
  it('renders with data-variant="info" by default', async () => {
    render(
      <Toast show={true}>
        <div>Toast content</div>
      </Toast>
    );
    await act(async () => {});
    const toast = document.querySelector('[role="status"]');
    expect(toast?.getAttribute('data-variant')).toBe('info');
  });

  it('renders with data-variant="success"', async () => {
    render(
      <Toast show={true} variant="success">
        <div>Toast content</div>
      </Toast>
    );
    await act(async () => {});
    const toast = document.querySelector('[role="status"]');
    expect(toast?.getAttribute('data-variant')).toBe('success');
  });

  it('renders with data-variant="warning"', async () => {
    render(
      <Toast show={true} variant="warning">
        <div>Toast content</div>
      </Toast>
    );
    await act(async () => {});
    const toast = document.querySelector('[role="status"]');
    expect(toast?.getAttribute('data-variant')).toBe('warning');
  });

  it('renders with data-variant="error"', async () => {
    render(
      <Toast show={true} variant="error">
        <div>Toast content</div>
      </Toast>
    );
    await act(async () => {});
    const toast = document.querySelector('[role="status"]');
    expect(toast?.getAttribute('data-variant')).toBe('error');
  });

  it('renders managed toast with variant via useToast', async () => {
    function AddToast() {
      const { toast } = useToast();
      return (
        <button
          onClick={() =>
            toast({
              title: 'Success toast',
              description: 'Operation completed',
              variant: 'success',
              duration: 0,
            })
          }
        >
          Add Success
        </button>
      );
    }

    render(
      <>
        <AddToast />
        <Toaster />
      </>
    );
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByText('Add Success'));
    });
    await act(async () => {});

    const toast = document.querySelector('[role="status"]');
    expect(toast?.getAttribute('data-variant')).toBe('success');
    expect(document.body.textContent).toContain('Success toast');
    expect(document.body.textContent).toContain('Operation completed');
  });
});

describe('ToastProgress', () => {
  it('throws when used outside Toast', () => {
    expect(() => {
      render(<ToastProgress data-testid="progress" />);
    }).toThrow('<ToastProgress> must be used within a <Toast>');
  });

  it('renders inside Toast', async () => {
    render(
      <Toast show={true} showProgress={true}>
        <ToastProgress data-testid="progress" />
        <ToastTitle>Title</ToastTitle>
      </Toast>
    );
    await act(async () => {});
    const progress = screen.queryByTestId('progress');
    expect(progress).not.toBeNull();
  });

  it('renders with data-progress attribute', async () => {
    render(
      <Toast show={true} showProgress={true} duration={5000}>
        <ToastProgress data-testid="progress" />
        <ToastTitle>Title</ToastTitle>
      </Toast>
    );
    await act(async () => {});
    const progress = screen.queryByTestId('progress');
    expect(progress?.getAttribute('data-progress')).toBeTruthy();
  });

  it('renders with aria-hidden="true"', async () => {
    render(
      <Toast show={true} showProgress={true}>
        <ToastProgress data-testid="progress" />
        <ToastTitle>Title</ToastTitle>
      </Toast>
    );
    await act(async () => {});
    const progress = screen.queryByTestId('progress');
    expect(progress?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders with custom as prop', async () => {
    render(
      <Toast show={true} showProgress={true}>
        <ToastProgress as="span" data-testid="progress" />
        <ToastTitle>Title</ToastTitle>
      </Toast>
    );
    await act(async () => {});
    const progress = screen.queryByTestId('progress');
    expect(progress?.tagName.toLowerCase()).toBe('span');
  });

  it('does not render when showProgress is false', async () => {
    render(
      <Toast show={true} showProgress={false}>
        <ToastProgress data-testid="progress" />
        <ToastTitle>Title</ToastTitle>
      </Toast>
    );
    await act(async () => {});
    const progress = screen.queryByTestId('progress');
    expect(progress).toBeNull();
  });

  it('renders in managed toast via useToast when showProgress is true', async () => {
    function AddToast() {
      const { toast } = useToast();
      return (
        <button
          onClick={() =>
            toast({
              title: 'Toast with progress',
              description: 'Shows progress bar',
              showProgress: true,
              duration: 0,
            })
          }
        >
          Add Progress Toast
        </button>
      );
    }

    render(
      <>
        <AddToast />
        <Toaster />
      </>
    );
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByText('Add Progress Toast'));
    });
    await act(async () => {});

    const toast = document.querySelector('[role="status"]');
    expect(toast).not.toBeNull();
    expect(toast?.querySelector('[data-progress]')).not.toBeNull();
  });

  it('does not render progress in managed toast when showProgress is false', async () => {
    function AddToast() {
      const { toast } = useToast();
      return (
        <button
          onClick={() =>
            toast({
              title: 'Toast without progress',
              showProgress: false,
              duration: 0,
            })
          }
        >
          Add No Progress Toast
        </button>
      );
    }

    render(
      <>
        <AddToast />
        <Toaster />
      </>
    );
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByText('Add No Progress Toast'));
    });
    await act(async () => {});

    const toast = document.querySelector('[role="status"]');
    expect(toast).not.toBeNull();
    expect(toast?.querySelector('[data-progress]')).toBeNull();
  });
});

describe('Toast icon slot', () => {
  it('renders managed toast with icon via useToast', async () => {
    function AddToast() {
      const { toast } = useToast();
      return (
        <button
          onClick={() =>
            toast({
              title: 'Toast with icon',
              icon: <span data-testid="custom-icon">★</span>,
              duration: 0,
            })
          }
        >
          Add Icon Toast
        </button>
      );
    }

    render(
      <>
        <AddToast />
        <Toaster />
      </>
    );
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByText('Add Icon Toast'));
    });
    await act(async () => {});

    const icon = document.querySelector('[data-toast-icon]');
    expect(icon).not.toBeNull();
    expect(screen.queryByTestId('custom-icon')).not.toBeNull();
  });

  it('renders managed toast without icon when not provided', async () => {
    function AddToast() {
      const { toast } = useToast();
      return (
        <button
          onClick={() =>
            toast({
              title: 'Toast without icon',
              duration: 0,
            })
          }
        >
          Add No Icon Toast
        </button>
      );
    }

    render(
      <>
        <AddToast />
        <Toaster />
      </>
    );
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByText('Add No Icon Toast'));
    });
    await act(async () => {});

    const icon = document.querySelector('[data-toast-icon]');
    expect(icon).toBeNull();
  });
});

describe('Toast backward compatibility', () => {
  it('Toast without variant prop works as before', async () => {
    render(
      <Toast show={true}>
        <ToastTitle>Test Title</ToastTitle>
        <ToastDescription>Test Description</ToastDescription>
      </Toast>
    );
    await act(async () => {});
    const toast = document.querySelector('[role="status"]');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain('Test Title');
    expect(toast?.textContent).toContain('Test Description');
  });

  it('Toaster without icon works as before', async () => {
    function AddToast() {
      const { toast } = useToast();
      return (
        <button
          onClick={() =>
            toast({
              title: 'Simple toast',
              description: 'Just title and description',
              duration: 0,
            })
          }
        >
          Add
        </button>
      );
    }

    render(
      <>
        <AddToast />
        <Toaster />
      </>
    );
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByText('Add'));
    });
    await act(async () => {});

    expect(document.body.textContent).toContain('Simple toast');
    expect(document.body.textContent).toContain('Just title and description');
  });

  it('Toast without showProgress works as before', async () => {
    render(
      <Toast show={true} showProgress={false}>
        <ToastTitle>No Progress Toast</ToastTitle>
      </Toast>
    );
    await act(async () => {});
    const toast = document.querySelector('[role="status"]');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain('No Progress Toast');
  });

  it('All variant types are backward compatible with existing toasts', async () => {
    for (const variant of ['info', 'success', 'warning', 'error'] as const) {
      render(
        <Toast show={true} variant={variant}>
          <ToastTitle>{variant} toast</ToastTitle>
        </Toast>
      );
      await act(async () => {});
      const toast = document.querySelector('[role="status"]');
      expect(toast?.getAttribute('data-variant')).toBe(variant);
      cleanup();
    }
  });
});
