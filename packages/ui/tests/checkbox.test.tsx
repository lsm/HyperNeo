import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Checkbox } from '../src/mod.ts';

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

describe('Checkbox', () => {
  it('renders unchecked by default', () => {
    render(<Checkbox />);
    const cb = screen.getByRole('checkbox');
    expect(cb.getAttribute('aria-checked')).toBe('false');
  });

  it('renders checked when defaultChecked=true', () => {
    render(<Checkbox defaultChecked />);
    const cb = screen.getByRole('checkbox');
    expect(cb.getAttribute('aria-checked')).toBe('true');
  });

  it('sets role="checkbox"', () => {
    render(<Checkbox />);
    expect(screen.getByRole('checkbox')).toBeTruthy();
  });

  it('sets aria-checked reflecting checked state', () => {
    render(<Checkbox defaultChecked={false} />);
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
  });

  it('toggles on click', () => {
    render(<Checkbox />);
    const cb = screen.getByRole('checkbox');
    expect(cb.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(cb);
    expect(cb.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(cb);
    expect(cb.getAttribute('aria-checked')).toBe('false');
  });

  it('toggles on Space key', () => {
    render(<Checkbox />);
    const cb = screen.getByRole('checkbox');
    fireEvent.keyDown(cb, { key: ' ' });
    expect(cb.getAttribute('aria-checked')).toBe('true');
  });

  it('does not toggle on other keys', () => {
    render(<Checkbox />);
    const cb = screen.getByRole('checkbox');
    fireEvent.keyDown(cb, { key: 'Tab' });
    expect(cb.getAttribute('aria-checked')).toBe('false');
  });

  it('works as controlled component with checked + onChange', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} />);
    const cb = screen.getByRole('checkbox');
    fireEvent.click(cb);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(cb.getAttribute('aria-checked')).toBe('false');
  });

  it('controlled checked=true renders checked', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={true} onChange={onChange} />);
    const cb = screen.getByRole('checkbox');
    expect(cb.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(cb);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('indeterminate prop sets aria-checked="mixed"', () => {
    render(<Checkbox indeterminate />);
    const cb = screen.getByRole('checkbox');
    expect(cb.getAttribute('aria-checked')).toBe('mixed');
  });

  it('sets data-indeterminate attribute when indeterminate', () => {
    render(<Checkbox indeterminate />);
    const cb = screen.getByRole('checkbox');
    expect(cb.hasAttribute('data-indeterminate')).toBe(true);
  });

  it('does not set data-indeterminate when not indeterminate', () => {
    render(<Checkbox />);
    const cb = screen.getByRole('checkbox');
    expect(cb.hasAttribute('data-indeterminate')).toBe(false);
  });

  it('indeterminate=false keeps normal aria-checked', () => {
    render(<Checkbox indeterminate={false} defaultChecked />);
    const cb = screen.getByRole('checkbox');
    expect(cb.getAttribute('aria-checked')).toBe('true');
  });

  it('disabled prevents click toggle', () => {
    render(<Checkbox disabled />);
    const cb = screen.getByRole('checkbox');
    fireEvent.click(cb);
    expect(cb.getAttribute('aria-checked')).toBe('false');
  });

  it('disabled prevents Space key toggle', () => {
    render(<Checkbox disabled />);
    const cb = screen.getByRole('checkbox');
    fireEvent.keyDown(cb, { key: ' ' });
    expect(cb.getAttribute('aria-checked')).toBe('false');
  });

  it('disabled prevents Enter key from toggling', () => {
    render(<Checkbox disabled />);
    const cb = screen.getByRole('checkbox');
    fireEvent.keyDown(cb, { key: 'Enter' });
    expect(cb.getAttribute('aria-checked')).toBe('false');
  });

  it('renders hidden input when name is provided', () => {
    render(<Checkbox name="my-checkbox" />);
    const input = document.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.getAttribute('name')).toBe('my-checkbox');
  });

  it('hidden input has empty value when unchecked', () => {
    render(<Checkbox name="my-checkbox" />);
    const input = document.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    expect(input?.value).toBe('');
  });

  it('hidden input has value="on" (default) when checked', () => {
    render(<Checkbox name="my-checkbox" defaultChecked />);
    const input = document.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    expect(input?.value).toBe('on');
  });

  it('hidden input uses custom value prop when checked', () => {
    render(<Checkbox name="my-checkbox" value="yes" defaultChecked />);
    const input = document.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    expect(input?.value).toBe('yes');
  });

  it('does not render hidden input when name is not provided', () => {
    render(<Checkbox />);
    expect(document.querySelector('input[type="hidden"]')).toBeNull();
  });

  it('passes form prop to hidden input', () => {
    render(<Checkbox name="c" form="my-form" />);
    const input = document.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    expect(input?.getAttribute('form')).toBe('my-form');
  });

  it('sets data-hover when pointer enters and clears on leave', () => {
    render(<Checkbox />);
    const cb = screen.getByRole('checkbox');
    fireEvent.mouseEnter(cb);
    expect(cb.hasAttribute('data-hover')).toBe(true);
    fireEvent.mouseLeave(cb);
    expect(cb.hasAttribute('data-hover')).toBe(false);
  });

  it('sets data-focus on focus and clears on blur', async () => {
    render(<Checkbox />);
    const cb = screen.getByRole('checkbox');
    await act(async () => {
      cb.focus();
    });
    expect(cb.hasAttribute('data-focus')).toBe(true);
    await act(async () => {
      cb.blur();
    });
    expect(cb.hasAttribute('data-focus')).toBe(false);
  });

  it('sets data-active on mousedown and clears on mouseup', () => {
    render(<Checkbox />);
    const cb = screen.getByRole('checkbox');
    fireEvent.mouseDown(cb);
    expect(cb.hasAttribute('data-active')).toBe(true);
    fireEvent.mouseUp(cb);
    expect(cb.hasAttribute('data-active')).toBe(false);
  });

  it('sets data-checked when checked', () => {
    render(<Checkbox defaultChecked />);
    const cb = screen.getByRole('checkbox');
    expect(cb.hasAttribute('data-checked')).toBe(true);
  });

  it('does not set data-checked when unchecked', () => {
    render(<Checkbox />);
    const cb = screen.getByRole('checkbox');
    expect(cb.hasAttribute('data-checked')).toBe(false);
  });

  it('sets data-disabled when disabled', () => {
    render(<Checkbox disabled />);
    const cb = screen.getByRole('checkbox');
    expect(cb.hasAttribute('data-disabled')).toBe(true);
  });

  it('changing state: briefly true after toggle, cleared by rAF', async () => {
    const raf = new RAFQueue();
    raf.install();

    render(<Checkbox />);
    const cb = screen.getByRole('checkbox');

    await act(async () => {
      fireEvent.click(cb);
    });
    expect(cb.hasAttribute('data-changing')).toBe(true);

    await act(async () => {
      raf.flush();
    });
    expect(cb.hasAttribute('data-changing')).toBe(false);
  });

  it('changing state: cancels previous rAF if toggled rapidly', async () => {
    const raf = new RAFQueue();
    raf.install();

    render(<Checkbox />);
    const cb = screen.getByRole('checkbox');

    await act(async () => {
      fireEvent.click(cb);
    });
    await act(async () => {
      fireEvent.click(cb);
    });

    expect(cb.hasAttribute('data-changing')).toBe(true);

    await act(async () => {
      raf.flush();
    });
    expect(cb.hasAttribute('data-changing')).toBe(false);
  });

  it('default element is span (not button)', () => {
    render(<Checkbox />);
    const cb = screen.getByRole('checkbox');
    expect(cb.tagName.toLowerCase()).toBe('span');
  });

  it('renders with custom as="div" element', () => {
    render(<Checkbox as="div" />);
    const cb = screen.getByRole('checkbox');
    expect(cb.tagName.toLowerCase()).toBe('div');
  });

  it('render prop receives slot values', () => {
    let slotValues: Record<string, unknown> | null = null;
    render(
      <Checkbox defaultChecked indeterminate>
        {(slot: Record<string, unknown>) => {
          slotValues = slot;
          return <span>content</span>;
        }}
      </Checkbox>
    );
    expect(slotValues).not.toBeNull();
    expect(slotValues?.checked).toBe(true);
    expect(slotValues?.disabled).toBe(false);
    expect(slotValues?.indeterminate).toBe(true);
    expect(typeof slotValues?.hover).toBe('boolean');
    expect(typeof slotValues?.focus).toBe('boolean');
    expect(typeof slotValues?.active).toBe('boolean');
    expect(typeof slotValues?.changing).toBe('boolean');
  });

  it('Enter key submits form with submit button', () => {
    const handleSubmit = vi.fn((e: Event) => e.preventDefault());
    render(
      <form onSubmit={handleSubmit}>
        <Checkbox name="c" />
        <button type="submit">Submit</button>
      </form>
    );
    const cb = screen.getByRole('checkbox');
    const submitBtn = screen.getByText('Submit');
    const clickSpy = vi.spyOn(submitBtn, 'click');
    fireEvent.keyDown(cb, { key: 'Enter' });
    expect(clickSpy).toHaveBeenCalled();
  });

  it('Enter key calls form.requestSubmit when no submit button', () => {
    const requestSubmit = vi.fn();
    render(
      <form>
        <Checkbox name="c" />
      </form>
    );
    const form = document.querySelector('form') as HTMLFormElement;
    form.requestSubmit = requestSubmit;
    const cb = screen.getByRole('checkbox');
    fireEvent.keyDown(cb, { key: 'Enter' });
    expect(requestSubmit).toHaveBeenCalled();
  });

  it('Enter key outside form does nothing', () => {
    render(<Checkbox name="c" />);
    const cb = screen.getByRole('checkbox');
    fireEvent.keyDown(cb, { key: 'Enter' });
    expect(cb.getAttribute('aria-checked')).toBe('false');
  });

  it('has tabIndex 0', () => {
    render(<Checkbox />);
    const cb = screen.getByRole('checkbox');
    expect(cb.getAttribute('tabindex')).toBe('0');
  });

  it('passes through extra props', () => {
    render(<Checkbox data-testid="my-checkbox" />);
    expect(screen.getByTestId('my-checkbox')).toBeTruthy();
  });
});
