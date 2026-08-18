import { act, cleanup, render } from '@testing-library/preact';
import { useRef } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOutsideClick } from '../../src/internal/use-outside-click.ts';

afterEach(() => {
  cleanup();
});

function firePointerDown(target: Element) {
  const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { value: target, configurable: true });
  document.dispatchEvent(event);
}

describe('useOutsideClick', () => {
  it('calls callback when clicking outside container', async () => {
    const callback = vi.fn();

    function TestComponent() {
      const ref = useRef<HTMLDivElement | null>(null);
      useOutsideClick([ref], callback, true);
      return (
        <div>
          <div ref={ref} id="inside">
            Inside
          </div>
          <div id="outside">Outside</div>
        </div>
      );
    }

    render(<TestComponent />);
    await act(async () => {});

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const outside = document.getElementById('outside');
    await act(async () => {
      firePointerDown(outside as Element);
    });

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not call callback when clicking inside container', async () => {
    const callback = vi.fn();

    function TestComponent() {
      const ref = useRef<HTMLDivElement | null>(null);
      useOutsideClick([ref], callback, true);
      return (
        <div ref={ref} id="container">
          <button type="button" id="inside-btn">
            Click me
          </button>
        </div>
      );
    }

    render(<TestComponent />);
    await act(async () => {});
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const insideBtn = document.getElementById('inside-btn');
    await act(async () => {
      firePointerDown(insideBtn as Element);
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('does not call callback when disabled', async () => {
    const callback = vi.fn();

    function TestComponent() {
      const ref = useRef<HTMLDivElement | null>(null);
      useOutsideClick([ref], callback, false);
      return (
        <div>
          <div ref={ref} id="container">
            Inside
          </div>
          <div id="outside-disabled">Outside</div>
        </div>
      );
    }

    render(<TestComponent />);
    await act(async () => {});
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const outside = document.getElementById('outside-disabled');
    await act(async () => {
      firePointerDown(outside as Element);
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('supports multiple container refs', async () => {
    const callback = vi.fn();

    function TestComponent() {
      const ref1 = useRef<HTMLDivElement | null>(null);
      const ref2 = useRef<HTMLDivElement | null>(null);
      useOutsideClick([ref1, ref2], callback, true);
      return (
        <div>
          <div ref={ref1} id="container1">
            Container 1
          </div>
          <div ref={ref2} id="container2">
            Container 2
          </div>
          <div id="truly-outside">Outside both</div>
        </div>
      );
    }

    render(<TestComponent />);
    await act(async () => {});
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const container2 = document.getElementById('container2');
    await act(async () => {
      firePointerDown(container2 as Element);
    });
    expect(callback).not.toHaveBeenCalled();

    const outside = document.getElementById('truly-outside');
    await act(async () => {
      firePointerDown(outside as Element);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('supports function-based container resolution', async () => {
    const callback = vi.fn();
    let _containerEl: HTMLDivElement | null = null;

    function TestComponent() {
      const ref = useRef<HTMLDivElement | null>(null);
      useOutsideClick(
        () => {
          _containerEl = ref.current;
          return [ref.current];
        },
        callback,
        true
      );
      return (
        <div>
          <div ref={ref} id="fn-container">
            Inside
          </div>
          <div id="fn-outside">Outside</div>
        </div>
      );
    }

    render(<TestComponent />);
    await act(async () => {});
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const outside = document.getElementById('fn-outside');
    await act(async () => {
      firePointerDown(outside as Element);
    });

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('cleans up event listener when enabled transitions to false', async () => {
    const callback = vi.fn();
    const _enabledState = true;

    function TestComponent({ enabled }: { enabled: boolean }) {
      const ref = useRef<HTMLDivElement | null>(null);
      useOutsideClick([ref], callback, enabled);
      return (
        <div>
          <div ref={ref} id="toggle-container">
            Inside
          </div>
          <div id="toggle-outside">Outside</div>
        </div>
      );
    }

    const { rerender } = render(<TestComponent enabled={true} />);
    await act(async () => {});
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    rerender(<TestComponent enabled={false} />);
    await act(async () => {});
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const outside = document.getElementById('toggle-outside');
    await act(async () => {
      firePointerDown(outside as Element);
    });

    expect(callback).not.toHaveBeenCalled();
  });
});
