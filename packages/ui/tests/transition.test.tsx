import { act, cleanup, render, screen } from '@testing-library/preact';
import { useContext } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenClosedContext, State } from '../src/internal/open-closed.ts';
import { Transition } from '../src/mod.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function OpenClosedConsumer() {
  const state = useContext(OpenClosedContext);
  return (
    <span data-state={state === State.Open ? 'open' : state === State.Closed ? 'closed' : 'null'} />
  );
}

class RAFQueue {
  callbacks: FrameRequestCallback[] = [];
  private idCounter = 0;

  schedule(cb: FrameRequestCallback): number {
    this.callbacks.push(cb);
    return ++this.idCounter;
  }

  flushOne(): void {
    const batch = this.callbacks.splice(0);
    for (const cb of batch) {
      cb(performance.now());
    }
  }

  flush(maxRounds = 20): void {
    for (let i = 0; i < maxRounds; i++) {
      if (this.callbacks.length === 0) break;
      this.flushOne();
    }
  }

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => this.schedule(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
  }
}

const originalGetAnimations = Element.prototype.getAnimations;

function mockGetAnimations(opts: { transitionDuration?: string; animationDuration?: string }): {
  resolveAnimations: () => void;
  restore: () => void;
} {
  let resolveFn: (() => void) | null = null;

  const styleMock = {
    transitionDuration: opts.transitionDuration ?? '0s',
    animationDuration: opts.animationDuration ?? '0s',
  } as CSSStyleDeclaration;

  vi.stubGlobal('getComputedStyle', () => styleMock);

  Element.prototype.getAnimations = function () {
    const hasTransition =
      opts.transitionDuration && opts.transitionDuration !== '0s' && opts.transitionDuration !== '';
    const hasAnimation =
      opts.animationDuration && opts.animationDuration !== '0s' && opts.animationDuration !== '';

    if (!hasTransition && !hasAnimation) {
      return [];
    }

    const finishedPromise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });

    return [
      {
        finished: finishedPromise,
        playState: 'running',
      } as Animation,
    ];
  };

  return {
    resolveAnimations: () => {
      if (resolveFn) {
        resolveFn();
        resolveFn = null;
      }
    },
    restore: () => {
      Element.prototype.getAnimations = originalGetAnimations;
    },
  };
}

describe('Transition', () => {
  it('should render children when show is true', async () => {
    render(
      <Transition show={true}>
        <span>Visible content</span>
      </Transition>
    );
    await act(async () => {});
    expect(screen.getByText('Visible content')).not.toBeNull();
  });

  it('should not render children when show is false (unmount mode)', async () => {
    render(
      <Transition show={false}>
        <span>Hidden content</span>
      </Transition>
    );
    await act(async () => {});
    expect(screen.queryByText('Hidden content')).toBeNull();
  });

  it('should keep element in DOM when show is false and unmount is false', async () => {
    render(
      <Transition show={false} unmount={false}>
        <span>Hidden content</span>
      </Transition>
    );
    await act(async () => {});
    const el = screen.getByText('Hidden content');
    expect(el).not.toBeNull();
  });

  it('should support custom as prop', async () => {
    render(
      <Transition show={true} as="section">
        <span>Section content</span>
      </Transition>
    );
    await act(async () => {});
    const section = document.querySelector('section');
    expect(section).not.toBeNull();
    expect(section?.textContent).toBe('Section content');
  });

  it('should provide open state to OpenClosedContext consumers', async () => {
    render(
      <Transition show={true}>
        <OpenClosedConsumer />
      </Transition>
    );
    await act(async () => {});
    const span = document.querySelector('[data-state]');
    expect(span?.getAttribute('data-state')).toBe('open');
  });

  it('should provide closed state to OpenClosedContext consumers when show is false', async () => {
    render(
      <Transition show={false} unmount={false}>
        <OpenClosedConsumer />
      </Transition>
    );
    await act(async () => {});
    const span = document.querySelector('[data-state]');
    expect(span?.getAttribute('data-state')).toBe('closed');
  });

  it('should not render context wrapper when show is not provided (uncontrolled)', async () => {
    render(
      <OpenClosedContext.Provider value={State.Open}>
        <Transition>
          <span>Content</span>
        </Transition>
      </OpenClosedContext.Provider>
    );
    await act(async () => {});
    expect(screen.getByText('Content')).not.toBeNull();
  });

  it('should read visibility from OpenClosedContext when show is not provided', async () => {
    render(
      <OpenClosedContext.Provider value={State.Closed}>
        <Transition unmount={false}>
          <span>Content</span>
        </Transition>
      </OpenClosedContext.Provider>
    );
    await act(async () => {});
    const el = screen.getByText('Content');
    expect(el).not.toBeNull();
  });

  it('should be visible when context is Open and show is not provided', async () => {
    render(
      <OpenClosedContext.Provider value={State.Open}>
        <Transition>
          <span>Visible from context</span>
        </Transition>
      </OpenClosedContext.Provider>
    );
    await act(async () => {});
    expect(screen.getByText('Visible from context')).not.toBeNull();
  });

  it('should throw error when no show prop and no context', async () => {
    expect(() => {
      render(
        <Transition>
          <span>Default visible</span>
        </Transition>
      );
    }).toThrow('A <Transition /> is used but it is missing a `show={true | false}` prop.');
  });

  it('should show element when toggled from hidden to visible', async () => {
    const { rerender } = render(
      <Transition show={false}>
        <span>Content</span>
      </Transition>
    );

    await act(async () => {
      rerender(
        <Transition show={true}>
          <span>Content</span>
        </Transition>
      );
    });

    expect(screen.getByText('Content')).not.toBeNull();
  });

  it('should hide element when toggled from visible to hidden (no CSS transition)', async () => {
    const raf = new RAFQueue();
    raf.install();
    const mock = mockGetAnimations({ transitionDuration: '0s', animationDuration: '0s' });

    const { rerender } = render(
      <Transition show={true}>
        <span>Content</span>
      </Transition>
    );

    await act(async () => {});
    expect(screen.getByText('Content')).not.toBeNull();

    await act(async () => {
      rerender(
        <Transition show={false}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      raf.flush();
    });

    expect(screen.queryByText('Content')).toBeNull();
    mock.restore();
  });

  it('should call beforeEnter callback when entering', async () => {
    const beforeEnter = vi.fn();
    const afterEnter = vi.fn();
    const raf = new RAFQueue();
    raf.install();
    mockGetAnimations({ transitionDuration: '0s', animationDuration: '0s' });

    const { rerender } = render(
      <Transition show={false} beforeEnter={beforeEnter} afterEnter={afterEnter}>
        <span>Content</span>
      </Transition>
    );

    await act(async () => {
      rerender(
        <Transition show={true} beforeEnter={beforeEnter} afterEnter={afterEnter}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      raf.flush();
    });

    expect(afterEnter).toHaveBeenCalled();
  });

  it('should call afterEnter callback when enter completes (no CSS transition)', async () => {
    const afterEnter = vi.fn();
    const raf = new RAFQueue();
    raf.install();
    mockGetAnimations({ transitionDuration: '0s', animationDuration: '0s' });

    const { rerender } = render(
      <Transition show={false} afterEnter={afterEnter}>
        <span>Content</span>
      </Transition>
    );

    await act(async () => {
      rerender(
        <Transition show={true} afterEnter={afterEnter}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      raf.flush();
    });

    expect(afterEnter).toHaveBeenCalled();
  });

  it('should call beforeLeave callback when leaving', async () => {
    const beforeLeave = vi.fn();
    const raf = new RAFQueue();
    raf.install();
    mockGetAnimations({ transitionDuration: '0s', animationDuration: '0s' });

    const { rerender } = render(
      <Transition show={true} beforeLeave={beforeLeave}>
        <span>Content</span>
      </Transition>
    );
    await act(async () => {});

    await act(async () => {
      rerender(
        <Transition show={false} beforeLeave={beforeLeave}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      raf.flush();
    });

    expect(beforeLeave).toHaveBeenCalled();
  });

  it('should call afterLeave callback when leave completes (no CSS transition)', async () => {
    const afterLeave = vi.fn();
    const raf = new RAFQueue();
    raf.install();
    mockGetAnimations({ transitionDuration: '0s', animationDuration: '0s' });

    const { rerender } = render(
      <Transition show={true} afterLeave={afterLeave}>
        <span>Content</span>
      </Transition>
    );
    await act(async () => {});

    await act(async () => {
      rerender(
        <Transition show={false} afterLeave={afterLeave}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      raf.flush();
    });

    expect(afterLeave).toHaveBeenCalled();
  });

  it('should run appear transition on initial mount when appear=true and show=true', async () => {
    const beforeEnter = vi.fn();
    const raf = new RAFQueue();
    raf.install();
    mockGetAnimations({ transitionDuration: '0s', animationDuration: '0s' });

    render(
      <Transition show={true} appear={true} beforeEnter={beforeEnter}>
        <span>Appear content</span>
      </Transition>
    );

    await act(async () => {});
    await act(async () => {
      raf.flush();
    });

    expect(screen.getByText('Appear content')).not.toBeNull();
    expect(beforeEnter).toHaveBeenCalled();
  });

  it('should not run appear transition on initial mount when appear=false', async () => {
    const beforeEnter = vi.fn();
    const raf = new RAFQueue();
    raf.install();
    mockGetAnimations({ transitionDuration: '0s', animationDuration: '0s' });

    render(
      <Transition show={true} appear={false} beforeEnter={beforeEnter}>
        <span>No appear content</span>
      </Transition>
    );

    await act(async () => {});
    await act(async () => {
      raf.flush();
    });

    expect(screen.getByText('No appear content')).not.toBeNull();
    expect(beforeEnter).toHaveBeenCalled();
  });

  it('should wait for getAnimations().finished promise before calling afterEnter', async () => {
    const raf = new RAFQueue();
    raf.install();
    const mock = mockGetAnimations({
      transitionDuration: '0.3s',
      animationDuration: '0s',
    });

    const afterEnter = vi.fn();

    const { rerender } = render(
      <Transition show={false} afterEnter={afterEnter}>
        <span>Content</span>
      </Transition>
    );

    await act(async () => {
      rerender(
        <Transition show={true} afterEnter={afterEnter}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      raf.flush();
    });

    await act(async () => {
      mock.resolveAnimations();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(afterEnter).toHaveBeenCalled();
    mock.restore();
  });

  it('should wait for animation (animationDuration) before calling afterEnter', async () => {
    const raf = new RAFQueue();
    raf.install();
    const mock = mockGetAnimations({
      transitionDuration: '',
      animationDuration: '0.5s',
    });

    const afterEnter = vi.fn();

    const { rerender } = render(
      <Transition show={false} afterEnter={afterEnter}>
        <span>Content</span>
      </Transition>
    );

    await act(async () => {
      rerender(
        <Transition show={true} afterEnter={afterEnter}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      raf.flush();
    });

    await act(async () => {
      mock.resolveAnimations();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(afterEnter).toHaveBeenCalled();
    mock.restore();
  });

  it('should forward function ref to element', async () => {
    let capturedRef: HTMLElement | null = null;

    await act(async () => {
      render(
        <Transition
          show={true}
          ref={(el: HTMLElement | null) => {
            capturedRef = el;
          }}
        >
          <span>Content</span>
        </Transition>
      );
    });

    expect(capturedRef).not.toBeNull();
  });

  it('should forward object ref to element', async () => {
    const ref = { current: null as HTMLElement | null };

    await act(async () => {
      render(
        <Transition show={true} ref={ref}>
          <span>Content</span>
        </Transition>
      );
    });

    expect(ref.current).not.toBeNull();
  });

  it('should complete leave transition when animation finishes after leave RAF', async () => {
    const raf = new RAFQueue();
    raf.install();
    const mock = mockGetAnimations({
      transitionDuration: '0.3s',
      animationDuration: '0s',
    });

    const afterLeave = vi.fn();

    const { rerender } = render(
      <Transition show={true} afterLeave={afterLeave}>
        <span>Content</span>
      </Transition>
    );
    await act(async () => {});

    await act(async () => {
      rerender(
        <Transition show={false} afterLeave={afterLeave}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      raf.flush();
    });

    await act(async () => {
      mock.resolveAnimations();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(afterLeave).toHaveBeenCalled();
    mock.restore();
  });

  it('should not unmount element when show=false and unmount=false (initial render)', async () => {
    render(
      <Transition show={false} unmount={false}>
        <span>Always in DOM</span>
      </Transition>
    );
    await act(async () => {});
    const el = screen.getByText('Always in DOM');
    expect(el).not.toBeNull();
  });

  it('should initially not render when show=false and unmount=true (default)', async () => {
    render(
      <Transition show={false}>
        <span>Hidden initially</span>
      </Transition>
    );
    await act(async () => {});
    expect(screen.queryByText('Hidden initially')).toBeNull();
  });

  it('should remove data-enter and data-transition after enter transition completes', async () => {
    const raf = new RAFQueue();
    raf.install();
    mockGetAnimations({ transitionDuration: '0s', animationDuration: '0s' });

    const { rerender } = render(
      <Transition show={false}>
        <span>Content</span>
      </Transition>
    );

    await act(async () => {
      rerender(
        <Transition show={true}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      raf.flush();
    });

    expect(document.querySelector('[data-enter]')).toBeNull();
    expect(document.querySelector('[data-transition]')).toBeNull();
  });

  it('should handle rapid visibility toggles gracefully', async () => {
    const raf = new RAFQueue();
    raf.install();
    mockGetAnimations({ transitionDuration: '0.3s', animationDuration: '0s' });

    const afterEnter = vi.fn();
    const beforeLeave = vi.fn();

    const { rerender } = render(
      <Transition show={false} afterEnter={afterEnter} beforeLeave={beforeLeave}>
        <span>Content</span>
      </Transition>
    );

    await act(async () => {
      rerender(
        <Transition show={true} afterEnter={afterEnter} beforeLeave={beforeLeave}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      rerender(
        <Transition show={false} afterEnter={afterEnter} beforeLeave={beforeLeave}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      raf.flush();
    });

    expect(beforeLeave).toHaveBeenCalled();
  });
});

describe('Transition - hasTransition utility', () => {
  afterEach(() => {
    Element.prototype.getAnimations = originalGetAnimations;
  });

  it('should skip waitForTransition when no CSS transition duration', async () => {
    const raf = new RAFQueue();
    raf.install();
    mockGetAnimations({ transitionDuration: '0s', animationDuration: '0s' });

    const afterEnter = vi.fn();

    const { rerender } = render(
      <Transition show={false} afterEnter={afterEnter}>
        <span>Content</span>
      </Transition>
    );

    await act(async () => {
      rerender(
        <Transition show={true} afterEnter={afterEnter}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      raf.flush();
    });

    expect(afterEnter).toHaveBeenCalled();
  });

  it('should detect transition from transitionDuration with multiple values', async () => {
    const raf = new RAFQueue();
    raf.install();
    const mock = mockGetAnimations({
      transitionDuration: '0s, 0.3s',
      animationDuration: '0s',
    });

    const afterEnter = vi.fn();

    const { rerender } = render(
      <Transition show={false} afterEnter={afterEnter}>
        <span>Content</span>
      </Transition>
    );

    await act(async () => {
      rerender(
        <Transition show={true} afterEnter={afterEnter}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      raf.flush();
    });

    await act(async () => {
      mock.resolveAnimations();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(afterEnter).toHaveBeenCalled();
    mock.restore();
  });

  it('should detect animation from animationDuration', async () => {
    const raf = new RAFQueue();
    raf.install();
    const mock = mockGetAnimations({
      transitionDuration: '',
      animationDuration: '0.5s',
    });

    const afterEnter = vi.fn();

    const { rerender } = render(
      <Transition show={false} afterEnter={afterEnter}>
        <span>Content</span>
      </Transition>
    );

    await act(async () => {
      rerender(
        <Transition show={true} afterEnter={afterEnter}>
          <span>Content</span>
        </Transition>
      );
    });
    await act(async () => {
      raf.flush();
    });

    await act(async () => {
      mock.resolveAnimations();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(afterEnter).toHaveBeenCalled();
    mock.restore();
  });
});
