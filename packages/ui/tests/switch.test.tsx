import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Switch } from '../src/mod.ts';

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

describe('Switch', () => {
  it('renders unchecked by default', () => {
    render(<Switch />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('renders checked when defaultChecked=true', () => {
    render(<Switch defaultChecked />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('sets role="switch"', () => {
    render(<Switch />);
    expect(screen.getByRole('switch')).toBeTruthy();
  });

  it('sets aria-checked reflecting checked state', () => {
    render(<Switch defaultChecked={false} />);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('toggles on click', () => {
    render(<Switch />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('toggles on Space key', () => {
    render(<Switch />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.keyDown(sw, { key: ' ' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('does not toggle on other keys', () => {
    render(<Switch />);
    const sw = screen.getByRole('switch');
    fireEvent.keyDown(sw, { key: 'Enter' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('works as controlled component with checked + onChange', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('controlled checked=true renders checked', () => {
    const onChange = vi.fn();
    render(<Switch checked={true} onChange={onChange} />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('disabled prevents click toggle', () => {
    render(<Switch disabled />);
    const sw = screen.getByRole('switch');
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('disabled prevents Space key toggle', () => {
    render(<Switch disabled />);
    const sw = screen.getByRole('switch');
    fireEvent.keyDown(sw, { key: ' ' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('disabled prevents Enter key form submit path (no throw)', () => {
    render(<Switch disabled />);
    const sw = screen.getByRole('switch');
    fireEvent.keyDown(sw, { key: 'Enter' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('renders hidden input when name is provided', () => {
    render(<Switch name="my-switch" />);
    const input = document.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.getAttribute('name')).toBe('my-switch');
  });

  it('hidden input has empty value when unchecked', () => {
    render(<Switch name="my-switch" />);
    const input = document.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    expect(input?.value).toBe('');
  });

  it('hidden input has value="on" (default) when checked', () => {
    render(<Switch name="my-switch" defaultChecked />);
    const input = document.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    expect(input?.value).toBe('on');
  });

  it('hidden input uses custom value prop when checked', () => {
    render(<Switch name="my-switch" value="enabled" defaultChecked />);
    const input = document.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    expect(input?.value).toBe('enabled');
  });

  it('does not render hidden input when name is not provided', () => {
    render(<Switch />);
    expect(document.querySelector('input[type="hidden"]')).toBeNull();
  });

  it('passes form prop to hidden input', () => {
    render(<Switch name="s" form="my-form" />);
    const input = document.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    expect(input?.getAttribute('form')).toBe('my-form');
  });

  it('sets data-hover when pointer enters and clears on leave', () => {
    render(<Switch />);
    const sw = screen.getByRole('switch');
    fireEvent.mouseEnter(sw);
    expect(sw.hasAttribute('data-hover')).toBe(true);
    fireEvent.mouseLeave(sw);
    expect(sw.hasAttribute('data-hover')).toBe(false);
  });

  it('sets data-focus on focus and clears on blur', async () => {
    render(<Switch />);
    const sw = screen.getByRole('switch');
    await act(async () => {
      sw.focus();
    });
    expect(sw.hasAttribute('data-focus')).toBe(true);
    await act(async () => {
      sw.blur();
    });
    expect(sw.hasAttribute('data-focus')).toBe(false);
  });

  it('sets data-active on mousedown and clears on mouseup', () => {
    render(<Switch />);
    const sw = screen.getByRole('switch');
    fireEvent.mouseDown(sw);
    expect(sw.hasAttribute('data-active')).toBe(true);
    fireEvent.mouseUp(sw);
    expect(sw.hasAttribute('data-active')).toBe(false);
  });

  it('sets data-checked when checked', () => {
    render(<Switch defaultChecked />);
    const sw = screen.getByRole('switch');
    expect(sw.hasAttribute('data-checked')).toBe(true);
  });

  it('does not set data-checked when unchecked', () => {
    render(<Switch />);
    const sw = screen.getByRole('switch');
    expect(sw.hasAttribute('data-checked')).toBe(false);
  });

  it('sets data-disabled when disabled', () => {
    render(<Switch disabled />);
    const sw = screen.getByRole('switch');
    expect(sw.hasAttribute('data-disabled')).toBe(true);
  });

  it('changing state: briefly true after toggle, cleared by rAF', async () => {
    const raf = new RAFQueue();
    raf.install();

    render(<Switch />);
    const sw = screen.getByRole('switch');

    await act(async () => {
      fireEvent.click(sw);
    });
    expect(sw.hasAttribute('data-changing')).toBe(true);

    await act(async () => {
      raf.flush();
    });
    expect(sw.hasAttribute('data-changing')).toBe(false);
  });

  it('changing state: cancels previous rAF if toggled rapidly', async () => {
    const raf = new RAFQueue();
    raf.install();

    render(<Switch />);
    const sw = screen.getByRole('switch');

    await act(async () => {
      fireEvent.click(sw);
    });
    await act(async () => {
      fireEvent.click(sw);
    });

    expect(sw.hasAttribute('data-changing')).toBe(true);

    await act(async () => {
      raf.flush();
    });
    expect(sw.hasAttribute('data-changing')).toBe(false);
  });

  it('renders with custom as="div" element', () => {
    render(<Switch as="div" />);
    const sw = screen.getByRole('switch');
    expect(sw.tagName.toLowerCase()).toBe('div');
  });

  it('default element is button', () => {
    render(<Switch />);
    const sw = screen.getByRole('switch');
    expect(sw.tagName.toLowerCase()).toBe('button');
  });

  it('render prop receives slot values', () => {
    let slotValues: Record<string, unknown> | null = null;
    render(
      <Switch defaultChecked>
        {(slot: Record<string, unknown>) => {
          slotValues = slot;
          return <span>content</span>;
        }}
      </Switch>
    );
    expect(slotValues).not.toBeNull();
    expect(slotValues?.checked).toBe(true);
    expect(slotValues?.disabled).toBe(false);
    expect(typeof slotValues?.hover).toBe('boolean');
    expect(typeof slotValues?.focus).toBe('boolean');
    expect(typeof slotValues?.active).toBe('boolean');
    expect(typeof slotValues?.changing).toBe('boolean');
  });

  it('Enter key submits form with submit button', () => {
    const handleSubmit = vi.fn((e: Event) => e.preventDefault());
    render(
      <form onSubmit={handleSubmit}>
        <Switch name="s" />
        <button type="submit">Submit</button>
      </form>
    );
    const sw = screen.getByRole('switch');
    const submitBtn = screen.getByText('Submit');
    const clickSpy = vi.spyOn(submitBtn, 'click');
    fireEvent.keyDown(sw, { key: 'Enter' });
    expect(clickSpy).toHaveBeenCalled();
  });

  it('Enter key calls form.requestSubmit when no submit button', () => {
    const requestSubmit = vi.fn();
    render(
      <form>
        <Switch name="s" />
      </form>
    );
    const form = document.querySelector('form') as HTMLFormElement;
    form.requestSubmit = requestSubmit;
    const sw = screen.getByRole('switch');
    fireEvent.keyDown(sw, { key: 'Enter' });
    expect(requestSubmit).toHaveBeenCalled();
  });

  it('Enter key outside form does nothing', () => {
    render(<Switch name="s" />);
    const sw = screen.getByRole('switch');
    fireEvent.keyDown(sw, { key: 'Enter' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('has tabIndex 0', () => {
    render(<Switch />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('tabindex')).toBe('0');
  });

  it('passes through extra props', () => {
    render(<Switch data-testid="my-switch" />);
    expect(screen.getByTestId('my-switch')).toBeTruthy();
  });
});
