import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Radio, RadioGroup } from '../src/mod.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RadioGroup', () => {
  it('sets role="radiogroup" on the container', () => {
    render(
      <RadioGroup>
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    expect(screen.getByRole('radiogroup')).toBeTruthy();
  });

  it('sets role="radio" on each Radio', () => {
    render(
      <RadioGroup>
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
  });

  it('renders with default element div for RadioGroup', () => {
    render(
      <RadioGroup>
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    expect(screen.getByRole('radiogroup').tagName.toLowerCase()).toBe('div');
  });

  it('Radio default element is span', () => {
    render(
      <RadioGroup>
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    const radio = screen.getByRole('radio');
    expect(radio.tagName.toLowerCase()).toBe('span');
  });

  it('uncontrolled: no radio checked by default', () => {
    render(
      <RadioGroup>
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const radios = screen.getAllByRole('radio');
    expect(radios[0].getAttribute('aria-checked')).toBe('false');
    expect(radios[1].getAttribute('aria-checked')).toBe('false');
  });

  it('uncontrolled: defaultValue selects the matching radio', () => {
    render(
      <RadioGroup defaultValue="b">
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const [a, b] = screen.getAllByRole('radio');
    expect(a.getAttribute('aria-checked')).toBe('false');
    expect(b.getAttribute('aria-checked')).toBe('true');
  });

  it('uncontrolled: clicking a radio selects it', async () => {
    render(
      <RadioGroup>
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const [a, b] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.click(a);
    });
    expect(a.getAttribute('aria-checked')).toBe('true');
    expect(b.getAttribute('aria-checked')).toBe('false');
  });

  it('controlled: value prop controls selection', () => {
    const onChange = vi.fn();
    render(
      <RadioGroup value="a" onChange={onChange}>
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const [a, b] = screen.getAllByRole('radio');
    expect(a.getAttribute('aria-checked')).toBe('true');
    expect(b.getAttribute('aria-checked')).toBe('false');
  });

  it('controlled: clicking calls onChange with the new value', async () => {
    const onChange = vi.fn();
    render(
      <RadioGroup value="a" onChange={onChange}>
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const [, b] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.click(b);
    });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('controlled: does not change internally after click (state stays external)', async () => {
    const onChange = vi.fn();
    render(
      <RadioGroup value="a" onChange={onChange}>
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const [, b] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.click(b);
    });
    const [a] = screen.getAllByRole('radio');
    expect(a.getAttribute('aria-checked')).toBe('true');
  });

  it('ArrowDown selects next radio', async () => {
    render(
      <RadioGroup defaultValue="a">
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
        <Radio value="c">C</Radio>
      </RadioGroup>
    );
    const [a, b] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.keyDown(a, { key: 'ArrowDown' });
    });
    expect(b.getAttribute('aria-checked')).toBe('true');
  });

  it('ArrowRight selects next radio', async () => {
    render(
      <RadioGroup defaultValue="a">
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const [a, b] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.keyDown(a, { key: 'ArrowRight' });
    });
    expect(b.getAttribute('aria-checked')).toBe('true');
  });

  it('ArrowUp selects previous radio', async () => {
    render(
      <RadioGroup defaultValue="b">
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
        <Radio value="c">C</Radio>
      </RadioGroup>
    );
    const [a, b] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.keyDown(b, { key: 'ArrowUp' });
    });
    expect(a.getAttribute('aria-checked')).toBe('true');
  });

  it('ArrowLeft selects previous radio', async () => {
    render(
      <RadioGroup defaultValue="b">
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const [a, b] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.keyDown(b, { key: 'ArrowLeft' });
    });
    expect(a.getAttribute('aria-checked')).toBe('true');
  });

  it('ArrowDown wraps around from last to first', async () => {
    render(
      <RadioGroup defaultValue="c">
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
        <Radio value="c">C</Radio>
      </RadioGroup>
    );
    const [a, , c] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.keyDown(c, { key: 'ArrowDown' });
    });
    expect(a.getAttribute('aria-checked')).toBe('true');
  });

  it('ArrowUp wraps around from first to last', async () => {
    render(
      <RadioGroup defaultValue="a">
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
        <Radio value="c">C</Radio>
      </RadioGroup>
    );
    const [a, , c] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.keyDown(a, { key: 'ArrowUp' });
    });
    expect(c.getAttribute('aria-checked')).toBe('true');
  });

  it('Space selects the focused (unchecked) radio', async () => {
    render(
      <RadioGroup>
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const [a] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.keyDown(a, { key: ' ' });
    });
    expect(a.getAttribute('aria-checked')).toBe('true');
  });

  it('Space on already-checked radio does not uncheck it', async () => {
    render(
      <RadioGroup defaultValue="a">
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const [a] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.keyDown(a, { key: ' ' });
    });
    expect(a.getAttribute('aria-checked')).toBe('true');
  });

  it('other keys do nothing', async () => {
    render(
      <RadioGroup defaultValue="a">
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const [a, b] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.keyDown(a, { key: 'Tab' });
    });
    expect(a.getAttribute('aria-checked')).toBe('true');
    expect(b.getAttribute('aria-checked')).toBe('false');
  });

  it('disabled Radio is skipped during ArrowDown navigation', async () => {
    render(
      <RadioGroup defaultValue="a">
        <Radio value="a">A</Radio>
        <Radio value="b" disabled>
          B
        </Radio>
        <Radio value="c">C</Radio>
      </RadioGroup>
    );
    const [a, , c] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.keyDown(a, { key: 'ArrowDown' });
    });
    expect(c.getAttribute('aria-checked')).toBe('true');
  });

  it('disabled Radio is skipped during ArrowUp navigation', async () => {
    render(
      <RadioGroup defaultValue="c">
        <Radio value="a">A</Radio>
        <Radio value="b" disabled>
          B
        </Radio>
        <Radio value="c">C</Radio>
      </RadioGroup>
    );
    const [a, , c] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.keyDown(c, { key: 'ArrowUp' });
    });
    expect(a.getAttribute('aria-checked')).toBe('true');
  });

  it('disabled Radio cannot be clicked', async () => {
    render(
      <RadioGroup>
        <Radio value="a" disabled>
          A
        </Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const [a] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.click(a);
    });
    expect(a.getAttribute('aria-checked')).toBe('false');
  });

  it('disabled Radio does not respond to keyboard', async () => {
    render(
      <RadioGroup defaultValue="a">
        <Radio value="a" disabled>
          A
        </Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const [a] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.keyDown(a, { key: 'ArrowDown' });
    });
    expect(a.getAttribute('aria-checked')).toBe('true');
  });

  it('group-level disabled disables all radios', async () => {
    render(
      <RadioGroup disabled>
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
      </RadioGroup>
    );
    const [a, b] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.click(a);
    });
    expect(a.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      fireEvent.click(b);
    });
    expect(b.getAttribute('aria-checked')).toBe('false');
  });

  it('group-level disabled sets data-disabled on container', () => {
    render(
      <RadioGroup disabled>
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    expect(screen.getByRole('radiogroup').hasAttribute('data-disabled')).toBe(true);
  });

  it('selected radio gets tabIndex=0, others get -1', async () => {
    render(
      <RadioGroup defaultValue="b">
        <Radio value="a">A</Radio>
        <Radio value="b">B</Radio>
        <Radio value="c">C</Radio>
      </RadioGroup>
    );
    const [a, b, c] = screen.getAllByRole('radio');
    await act(async () => {});
    expect(b.getAttribute('tabindex')).toBe('0');
    expect(a.getAttribute('tabindex')).toBe('-1');
    expect(c.getAttribute('tabindex')).toBe('-1');
  });

  it('when nothing selected, first non-disabled radio gets tabIndex=0', async () => {
    render(
      <RadioGroup>
        <Radio value="a" disabled>
          A
        </Radio>
        <Radio value="b">B</Radio>
        <Radio value="c">C</Radio>
      </RadioGroup>
    );
    await act(async () => {});
    const [, b, c] = screen.getAllByRole('radio');
    expect(b.getAttribute('tabindex')).toBe('0');
    expect(c.getAttribute('tabindex')).toBe('-1');
  });

  it('name prop renders a hidden input', () => {
    render(
      <RadioGroup name="choice" defaultValue="a">
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    const input = document.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.getAttribute('name')).toBe('choice');
    expect(input?.value).toBe('a');
  });

  it('hidden input value is empty string when no value selected', () => {
    render(
      <RadioGroup name="choice">
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    const input = document.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    expect(input?.value).toBe('');
  });

  it('form prop on hidden input', () => {
    render(
      <RadioGroup name="choice" form="my-form">
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    const input = document.querySelector('input[type="hidden"]') as HTMLInputElement | null;
    expect(input?.getAttribute('form')).toBe('my-form');
  });

  it('no hidden input when name is not provided', () => {
    render(
      <RadioGroup>
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    expect(document.querySelector('input[type="hidden"]')).toBeNull();
  });

  it('by string key: selects radio by comparing object property', async () => {
    const onChange = vi.fn();
    const options = [
      { id: 1, label: 'A' },
      { id: 2, label: 'B' },
    ];
    render(
      <RadioGroup value={options[0]} onChange={onChange} by="id">
        <Radio value={options[0]}>{options[0].label}</Radio>
        <Radio value={options[1]}>{options[1].label}</Radio>
      </RadioGroup>
    );
    const [a, b] = screen.getAllByRole('radio');
    expect(a.getAttribute('aria-checked')).toBe('true');
    expect(b.getAttribute('aria-checked')).toBe('false');
  });

  it('by string key: clicking selects by id comparison', async () => {
    const onChange = vi.fn();
    const options = [
      { id: 1, label: 'A' },
      { id: 2, label: 'B' },
    ];
    render(
      <RadioGroup value={options[0]} onChange={onChange} by="id">
        <Radio value={options[0]}>{options[0].label}</Radio>
        <Radio value={options[1]}>{options[1].label}</Radio>
      </RadioGroup>
    );
    const [, b] = screen.getAllByRole('radio');
    await act(async () => {
      fireEvent.click(b);
    });
    expect(onChange).toHaveBeenCalledWith(options[1]);
  });

  it('by function: uses custom comparator', async () => {
    const byFn = (a: unknown, b: unknown) => (a as { id: number }).id === (b as { id: number }).id;
    const options = [
      { id: 1, label: 'A' },
      { id: 2, label: 'B' },
    ];
    render(
      <RadioGroup value={options[1]} by={byFn}>
        <Radio value={options[0]}>{options[0].label}</Radio>
        <Radio value={options[1]}>{options[1].label}</Radio>
      </RadioGroup>
    );
    const [a, b] = screen.getAllByRole('radio');
    expect(a.getAttribute('aria-checked')).toBe('false');
    expect(b.getAttribute('aria-checked')).toBe('true');
  });

  it('Radio sets data-hover on mouseenter and clears on mouseleave', () => {
    render(
      <RadioGroup>
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    const radio = screen.getByRole('radio');
    fireEvent.mouseEnter(radio);
    expect(radio.hasAttribute('data-hover')).toBe(true);
    fireEvent.mouseLeave(radio);
    expect(radio.hasAttribute('data-hover')).toBe(false);
  });

  it('Radio sets data-focus on focus and clears on blur', async () => {
    render(
      <RadioGroup>
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    await act(async () => {});
    const radio = screen.getByRole('radio');
    await act(async () => {
      radio.focus();
    });
    expect(radio.hasAttribute('data-focus')).toBe(true);
    await act(async () => {
      radio.blur();
    });
    expect(radio.hasAttribute('data-focus')).toBe(false);
  });

  it('Radio sets data-active on mousedown and clears on mouseup', () => {
    render(
      <RadioGroup>
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    const radio = screen.getByRole('radio');
    fireEvent.mouseDown(radio);
    expect(radio.hasAttribute('data-active')).toBe(true);
    fireEvent.mouseUp(radio);
    expect(radio.hasAttribute('data-active')).toBe(false);
  });

  it('Radio sets data-checked when selected', async () => {
    render(
      <RadioGroup defaultValue="a">
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    await act(async () => {});
    const radio = screen.getByRole('radio');
    expect(radio.hasAttribute('data-checked')).toBe(true);
  });

  it('Radio does not set data-disabled when not disabled', () => {
    render(
      <RadioGroup>
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    const radio = screen.getByRole('radio');
    expect(radio.hasAttribute('data-disabled')).toBe(false);
  });

  it('Radio sets data-disabled when disabled individually', () => {
    render(
      <RadioGroup>
        <Radio value="a" disabled>
          A
        </Radio>
      </RadioGroup>
    );
    const radio = screen.getByRole('radio');
    expect(radio.hasAttribute('data-disabled')).toBe(true);
  });

  it('RadioGroup supports custom as="ul"', () => {
    render(
      <RadioGroup as="ul">
        <Radio value="a" as="li">
          A
        </Radio>
      </RadioGroup>
    );
    expect(screen.getByRole('radiogroup').tagName.toLowerCase()).toBe('ul');
  });

  it('Radio supports custom as="button"', () => {
    render(
      <RadioGroup>
        <Radio value="a" as="button">
          A
        </Radio>
      </RadioGroup>
    );
    const radio = screen.getByRole('radio');
    expect(radio.tagName.toLowerCase()).toBe('button');
  });

  it('throws when Radio used outside RadioGroup', () => {
    expect(() => {
      render(<Radio value="a">A</Radio>);
    }).toThrow('<Radio> must be used within a <RadioGroup>');
  });

  it('RadioGroup render prop receives slot with value', async () => {
    let slotValue: unknown = null;
    render(
      <RadioGroup defaultValue="a">
        {(slot: { value: unknown }) => {
          slotValue = slot.value;
          return <Radio value="a">A</Radio>;
        }}
      </RadioGroup>
    );
    await act(async () => {});
    expect(slotValue).toBe('a');
  });

  it('Radio render prop receives slot with checked and disabled', async () => {
    let slotValues: Record<string, unknown> | null = null;
    render(
      <RadioGroup defaultValue="a">
        <Radio value="a">
          {(slot: Record<string, unknown>) => {
            slotValues = slot;
            return <span>A</span>;
          }}
        </Radio>
      </RadioGroup>
    );
    await act(async () => {});
    expect(slotValues).not.toBeNull();
    expect(slotValues?.checked).toBe(true);
    expect(slotValues?.disabled).toBe(false);
  });

  it('RadioGroup passes through extra props', () => {
    render(
      <RadioGroup data-testid="rg">
        <Radio value="a">A</Radio>
      </RadioGroup>
    );
    expect(screen.getByTestId('rg')).toBeTruthy();
  });

  it('Radio passes through extra props', () => {
    render(
      <RadioGroup>
        <Radio value="a" data-testid="radio-a">
          A
        </Radio>
      </RadioGroup>
    );
    expect(screen.getByTestId('radio-a')).toBeTruthy();
  });
});
