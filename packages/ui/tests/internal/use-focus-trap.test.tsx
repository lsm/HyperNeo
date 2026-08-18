import { act, cleanup, render } from '@testing-library/preact';
import type { RefObject } from 'preact';
import { useRef } from 'preact/hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { useFocusTrap } from '../../src/internal/use-focus-trap.ts';

afterEach(() => {
  cleanup();
});

function TrapContainer({
  enabled = true,
  initialFocusRef,
  restoreFocus = true,
  children,
}: {
  enabled?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocus?: boolean;
  children?: preact.ComponentChildren;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(containerRef, enabled, { initialFocus: initialFocusRef, restoreFocus });
  return <div ref={containerRef}>{children}</div>;
}

describe('useFocusTrap', () => {
  it('sets focus to first focusable element on mount', async () => {
    const { container } = render(
      <TrapContainer>
        <button type="button" id="btn1">
          First
        </button>
        <button type="button" id="btn2">
          Second
        </button>
      </TrapContainer>
    );
    await act(async () => {});
    const btn1 = container.querySelector('#btn1') as HTMLElement;
    expect(document.activeElement).toBe(btn1);
  });

  it('does not trap focus when disabled', async () => {
    const outside = document.createElement('button');
    outside.id = 'outside';
    document.body.appendChild(outside);
    outside.focus();

    render(
      <TrapContainer enabled={false}>
        <button type="button" id="btn1">
          First
        </button>
      </TrapContainer>
    );
    await act(async () => {});

    expect(document.activeElement).toBe(outside);
    document.body.removeChild(outside);
  });

  it('focuses element with data-autofocus attribute', async () => {
    const { container } = render(
      <TrapContainer>
        <button type="button" id="btn1">
          First
        </button>
        <button type="button" id="btn2" data-autofocus>
          Auto
        </button>
      </TrapContainer>
    );
    await act(async () => {});
    const btn2 = container.querySelector('#btn2') as HTMLElement;
    expect(document.activeElement).toBe(btn2);
  });

  it('respects initialFocus ref', async () => {
    function WithInitialFocus() {
      const containerRef = useRef<HTMLDivElement | null>(null);
      const initialRef = useRef<HTMLButtonElement | null>(null);
      useFocusTrap(containerRef, true, { initialFocus: initialRef });
      return (
        <div ref={containerRef}>
          <button type="button" id="btn1">
            First
          </button>
          <button type="button" id="btn2" ref={initialRef}>
            Initial
          </button>
        </div>
      );
    }
    const { container } = render(<WithInitialFocus />);
    await act(async () => {});
    const btn2 = container.querySelector('#btn2') as HTMLElement;
    expect(document.activeElement).toBe(btn2);
  });

  it('traps Tab key — moves to next element', async () => {
    const { container } = render(
      <TrapContainer>
        <button type="button" id="btn1">
          First
        </button>
        <button type="button" id="btn2">
          Second
        </button>
      </TrapContainer>
    );
    await act(async () => {});

    const btn1 = container.querySelector('#btn1') as HTMLElement;
    const btn2 = container.querySelector('#btn2') as HTMLElement;
    btn1.focus();

    await act(async () => {
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.dispatchEvent(event);
    });

    expect(document.activeElement).toBe(btn2);
  });

  it('traps Shift+Tab key — wraps backwards to last element', async () => {
    const { container } = render(
      <TrapContainer>
        <button type="button" id="btn1">
          First
        </button>
        <button type="button" id="btn2">
          Second
        </button>
      </TrapContainer>
    );
    await act(async () => {});

    const btn1 = container.querySelector('#btn1') as HTMLElement;
    const btn2 = container.querySelector('#btn2') as HTMLElement;
    btn1.focus();

    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
    });

    expect(document.activeElement).toBe(btn2);
  });

  it('wraps Tab forward from last element to first', async () => {
    const { container } = render(
      <TrapContainer>
        <button type="button" id="btn1">
          First
        </button>
        <button type="button" id="btn2">
          Second
        </button>
      </TrapContainer>
    );
    await act(async () => {});

    const btn1 = container.querySelector('#btn1') as HTMLElement;
    const btn2 = container.querySelector('#btn2') as HTMLElement;
    btn2.focus();

    await act(async () => {
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.dispatchEvent(event);
    });

    expect(document.activeElement).toBe(btn1);
  });

  it('restores focus on unmount when restoreFocus=true', async () => {
    const outside = document.createElement('button');
    outside.id = 'outside-restore';
    document.body.appendChild(outside);
    outside.focus();

    const { unmount } = render(
      <TrapContainer restoreFocus={true}>
        <button type="button" id="trap-btn">
          Trap
        </button>
      </TrapContainer>
    );
    await act(async () => {});

    unmount();
    await act(async () => {});

    expect(document.activeElement).toBe(outside);
    document.body.removeChild(outside);
  });

  it('does not restore focus on unmount when restoreFocus=false', async () => {
    const outside = document.createElement('button');
    outside.id = 'outside-no-restore';
    document.body.appendChild(outside);
    outside.focus();

    const { unmount, container } = render(
      <TrapContainer restoreFocus={false}>
        <button type="button" id="trap-btn2">
          Trap
        </button>
      </TrapContainer>
    );
    await act(async () => {});

    const trapBtn = container.querySelector('#trap-btn2') as HTMLElement;
    expect(document.activeElement).toBe(trapBtn);

    unmount();
    await act(async () => {});

    expect(document.activeElement).not.toBe(outside);
    document.body.removeChild(outside);
  });

  it('focuses container as fallback when no focusable elements', async () => {
    function ContainerWithTabIndex() {
      const containerRef = useRef<HTMLDivElement | null>(null);
      useFocusTrap(containerRef, true);
      return (
        <div ref={containerRef} tabIndex={-1}>
          <span>No focusable</span>
        </div>
      );
    }
    const { container } = render(<ContainerWithTabIndex />);
    await act(async () => {});
    const div = container.querySelector('div') as HTMLElement;
    expect(document.activeElement).toBe(div);
  });

  it('ignores non-Tab keypresses', async () => {
    const { container } = render(
      <TrapContainer>
        <button type="button" id="btn-a">
          A
        </button>
        <button type="button" id="btn-b">
          B
        </button>
      </TrapContainer>
    );
    await act(async () => {});

    const btnA = container.querySelector('#btn-a') as HTMLElement;
    btnA.focus();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    });

    expect(document.activeElement).toBe(btnA);
  });
});
