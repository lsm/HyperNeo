import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloseContext, useClose } from '../../src/hooks/use-close.ts';

afterEach(() => {
  cleanup();
});

describe('useClose', () => {
  it('throws when used outside Dialog/Popover (no context)', () => {
    let error: Error | null = null;

    function ConsumerComponent() {
      try {
        useClose();
      } catch (e) {
        error = e as Error;
      }
      return <div />;
    }

    render(<ConsumerComponent />);

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/useClose\(\) must be used within a Dialog or Popover/);
  });

  it('returns the close function when inside CloseContext', () => {
    const closeFn = vi.fn();
    let capturedClose: (() => void) | null = null;

    function ConsumerComponent() {
      capturedClose = useClose();
      return <div id="close-consumer" />;
    }

    render(
      <CloseContext.Provider value={closeFn}>
        <ConsumerComponent />
      </CloseContext.Provider>
    );

    expect(capturedClose).toBe(closeFn);
  });

  it('calling the returned function invokes the context close function', async () => {
    const closeFn = vi.fn();
    let capturedClose: (() => void) | null = null;

    function ConsumerComponent() {
      capturedClose = useClose();
      return (
        <button type="button" id="close-btn" onClick={() => capturedClose?.()}>
          Close
        </button>
      );
    }

    const { container } = render(
      <CloseContext.Provider value={closeFn}>
        <ConsumerComponent />
      </CloseContext.Provider>
    );

    const btn = container.querySelector('#close-btn') as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });

    expect(closeFn).toHaveBeenCalledTimes(1);
  });
});
