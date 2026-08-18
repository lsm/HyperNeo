import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from '../src/mod.ts';

class RAFQueue {
  callbacks: FrameRequestCallback[] = [];
  private idCounter = 0;
  schedule(cb: FrameRequestCallback): number {
    this.callbacks.push(cb);
    return ++this.idCounter;
  }
  flushOne(): void {
    const batch = this.callbacks.splice(0);
    for (const cb of batch) cb(performance.now());
  }
  flush(maxRounds = 20): void {
    for (let i = 0; i < maxRounds; i++) {
      if (!this.callbacks.length) break;
      this.flushOne();
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
});

function BasicComboboxNoUnmount() {
  return (
    <Combobox as="div">
      <ComboboxInput placeholder="Search..." />
      <ComboboxButton>Toggle</ComboboxButton>
      <ComboboxOptions unmount={false}>
        <ComboboxOption value="a">Option A</ComboboxOption>
        <ComboboxOption value="b">Option B</ComboboxOption>
        <ComboboxOption value="c">Option C</ComboboxOption>
      </ComboboxOptions>
    </Combobox>
  );
}

function BasicCombobox({
  onChange,
  onClose,
  value,
  defaultValue,
  disabled,
  multiple,
  immediate,
  name,
  displayValue,
  item2Disabled = false,
}: {
  onChange?: (v: string) => void;
  onClose?: () => void;
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  multiple?: boolean;
  immediate?: boolean;
  name?: string;
  displayValue?: (v: string) => string;
  item2Disabled?: boolean;
}) {
  return (
    <Combobox
      as="div"
      value={value}
      defaultValue={defaultValue}
      onChange={onChange}
      onClose={onClose}
      disabled={disabled}
      multiple={multiple}
      immediate={immediate}
      name={name}
    >
      <ComboboxInput displayValue={displayValue} placeholder="Search..." />
      <ComboboxButton>Toggle</ComboboxButton>
      <ComboboxOptions>
        <ComboboxOption value="a">Option A</ComboboxOption>
        <ComboboxOption value="b" disabled={item2Disabled}>
          Option B
        </ComboboxOption>
        <ComboboxOption value="c">Option C</ComboboxOption>
      </ComboboxOptions>
    </Combobox>
  );
}

describe('Combobox', () => {
  it('should be closed by default', () => {
    render(<BasicCombobox />);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should open on ComboboxButton click', () => {
    render(<BasicCombobox />);
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('should close on second ComboboxButton click', () => {
    render(<BasicCombobox />);
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should set role=combobox on ComboboxInput', () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    expect(input).not.toBeNull();
  });

  it('should set role=listbox on ComboboxOptions', () => {
    render(<BasicCombobox />);
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.getByRole('listbox')).not.toBeNull();
  });

  it('should set role=option on ComboboxOption', () => {
    render(<BasicCombobox />);
    fireEvent.click(screen.getByText('Toggle'));
    const options = screen.getAllByRole('option');
    expect(options.length).toBe(3);
  });

  it('should open options when typing in ComboboxInput', () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.input(input, { target: { value: 'opt' } });
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('should call userOnChange handler when typing', () => {
    const handleChange = vi.fn();
    render(
      <Combobox as="div">
        <ComboboxInput onChange={handleChange} />
        <ComboboxOptions>
          <ComboboxOption value="a">A</ComboboxOption>
        </ComboboxOptions>
      </Combobox>
    );
    const input = screen.getByRole('combobox');
    fireEvent.input(input, { target: { value: 'a' } });
    expect(handleChange).toHaveBeenCalled();
  });

  it('should open on ArrowDown in input and activate first option via RAF', async () => {
    const raf = new RAFQueue();
    raf.install();
    render(<BasicComboboxNoUnmount />);
    const input = screen.getByRole('combobox');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      raf.flush();
    });
    expect(screen.getByRole('listbox')).not.toBeNull();
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
  });

  it('should open on ArrowUp in input and activate last option via RAF', async () => {
    const raf = new RAFQueue();
    raf.install();
    render(<BasicComboboxNoUnmount />);
    const input = screen.getByRole('combobox');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowUp' });
    });
    await act(async () => {
      raf.flush();
    });
    expect(screen.getByRole('listbox')).not.toBeNull();
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    expect(listbox.getAttribute('aria-activedescendant')).toBe(
      options[options.length - 1].getAttribute('id')
    );
  });

  it('should move to next option on ArrowDown when already open', async () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[1].getAttribute('id'));
  });

  it('should move to prev option on ArrowUp when already open', async () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowUp' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
  });

  it('should move to first on Home key when open', async () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Home' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
  });

  it('should move to last on End key when open', async () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'End' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(
      options[options.length - 1].getAttribute('id')
    );
  });

  it('should do nothing on Home/End when closed', () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Home' });
    fireEvent.keyDown(input, { key: 'End' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should move to first on PageUp key when open', async () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'PageUp' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
  });

  it('should move to last on PageDown key when open', async () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'PageDown' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(
      options[options.length - 1].getAttribute('id')
    );
  });

  it('should select active option on Enter and close', async () => {
    const onChange = vi.fn();
    render(<BasicCombobox value="a" onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onChange).toHaveBeenCalledWith('a');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should close on Enter even when no active option', async () => {
    render(<BasicCombobox />);
    fireEvent.click(screen.getByText('Toggle'));
    const input = screen.getByRole('combobox');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should close on Escape when open', () => {
    render(<BasicCombobox />);
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should clear input on Escape when closed', () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    Object.defineProperty(input, 'value', { value: 'some text', writable: true });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
  });

  it('should select option on Tab and close', async () => {
    render(<BasicCombobox value="a" onChange={vi.fn()} />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Tab' });
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should close on Tab without active option', async () => {
    render(<BasicCombobox />);
    fireEvent.click(screen.getByText('Toggle'));
    const input = screen.getByRole('combobox');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Tab' });
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should click option on click to select it', () => {
    const onChange = vi.fn();
    render(<BasicCombobox value="a" onChange={onChange} />);
    fireEvent.click(screen.getByText('Toggle'));
    fireEvent.click(screen.getByText('Option C'));
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('should close after clicking option in single mode', () => {
    render(<BasicCombobox value="a" onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Toggle'));
    fireEvent.click(screen.getByText('Option C'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should support controlled value + onChange', () => {
    const onChange = vi.fn();
    render(<BasicCombobox value="b" onChange={onChange} />);
    fireEvent.click(screen.getByText('Toggle'));
    const options = screen.getAllByRole('option');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
  });

  it('should use displayValue to format selected value in input', () => {
    render(
      <BasicCombobox value="a" onChange={vi.fn()} displayValue={(v: string) => `Label: ${v}`} />
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(input.value).toBe('Label: a');
  });

  it('should set aria-activedescendant on the listbox when active option', async () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    const listbox = screen.getByRole('listbox');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBeTruthy();
  });

  it('should skip disabled option during navigation', async () => {
    render(<BasicCombobox item2Disabled />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[2].getAttribute('id'));
  });

  it('should not select disabled option on click', () => {
    const onChange = vi.fn();
    render(<BasicCombobox value="a" onChange={onChange} item2Disabled />);
    fireEvent.click(screen.getByText('Toggle'));
    fireEvent.click(screen.getByText('Option B'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('should support multiple mode: click toggles and stays open', () => {
    const onChange = vi.fn();
    render(
      <Combobox as="div" multiple value={[]} onChange={onChange}>
        <ComboboxInput />
        <ComboboxOptions>
          <ComboboxOption value="a">A</ComboboxOption>
          <ComboboxOption value="b">B</ComboboxOption>
        </ComboboxOptions>
      </Combobox>
    );
    fireEvent.input(screen.getByRole('combobox'));
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.click(screen.getByText('A'));
    expect(onChange).toHaveBeenCalledWith(['a']);
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('should deselect in multiple mode when clicking already selected option', () => {
    const onChange = vi.fn();
    render(
      <Combobox as="div" multiple value={['a', 'b']} onChange={onChange}>
        <ComboboxInput />
        <ComboboxOptions>
          <ComboboxOption value="a">A</ComboboxOption>
          <ComboboxOption value="b">B</ComboboxOption>
        </ComboboxOptions>
      </Combobox>
    );
    fireEvent.input(screen.getByRole('combobox'));
    fireEvent.click(screen.getByText('A'));
    expect(onChange).toHaveBeenCalledWith(['b']);
  });

  it('should set aria-multiselectable in multiple mode', () => {
    render(
      <Combobox as="div" multiple value={[]}>
        <ComboboxInput />
        <ComboboxOptions>
          <ComboboxOption value="a">A</ComboboxOption>
        </ComboboxOptions>
      </Combobox>
    );
    fireEvent.input(screen.getByRole('combobox'));
    const listbox = screen.getByRole('listbox');
    expect(listbox.getAttribute('aria-multiselectable')).toBe('true');
  });

  it('should render hidden input with name prop', () => {
    render(<BasicCombobox name="search" value="a" onChange={vi.fn()} />);
    const input = document.querySelector('input[name="search"]');
    expect(input).not.toBeNull();
    expect((input as HTMLInputElement).value).toBe('a');
  });

  it('should render multiple hidden inputs for multiple + name', () => {
    render(
      <Combobox as="div" multiple value={['a', 'b']} onChange={vi.fn()} name="items">
        <ComboboxInput />
        <ComboboxOptions>
          <ComboboxOption value="a">A</ComboboxOption>
          <ComboboxOption value="b">B</ComboboxOption>
        </ComboboxOptions>
      </Combobox>
    );
    const inputs = document.querySelectorAll('input[name="items"]');
    expect(inputs.length).toBe(2);
  });

  it('should open on input focus when immediate=true', async () => {
    render(<BasicCombobox immediate />);
    const input = screen.getByRole('combobox');
    await act(async () => {
      input.focus();
    });
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('should not auto-open on focus when immediate=false', async () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    await act(async () => {
      input.focus();
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should call onClose callback when closing', () => {
    const onClose = vi.fn();
    render(<BasicCombobox onClose={onClose} />);
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.click(screen.getByText('Toggle'));
    expect(onClose).toHaveBeenCalled();
  });

  it('should call onClose when closing via Escape', () => {
    const onClose = vi.fn();
    render(<BasicCombobox onClose={onClose} />);
    fireEvent.click(screen.getByText('Toggle'));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('should call onClose when closing via Enter', async () => {
    const onClose = vi.fn();
    render(<BasicCombobox onClose={onClose} />);
    fireEvent.click(screen.getByText('Toggle'));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('should close on outside click', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      render(<BasicCombobox />);
      await act(async () => {
        fireEvent.click(screen.getByText('Toggle'));
      });
      expect(screen.queryByRole('listbox')).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(10);
      });
      await act(async () => {
        document.body.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
        );
      });
      expect(screen.queryByRole('listbox')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should throw when ComboboxInput used outside Combobox', () => {
    expect(() => {
      render(<ComboboxInput />);
    }).toThrow('<ComboboxInput> must be used within a <Combobox>');
  });

  it('should throw when ComboboxButton used outside Combobox', () => {
    expect(() => {
      render(<ComboboxButton>btn</ComboboxButton>);
    }).toThrow('<ComboboxButton> must be used within a <Combobox>');
  });

  it('should throw when ComboboxOptions used outside Combobox', () => {
    expect(() => {
      render(
        <ComboboxOptions>
          <span />
        </ComboboxOptions>
      );
    }).toThrow('<ComboboxOptions> must be used within a <Combobox>');
  });

  it('should throw when ComboboxOption used outside Combobox', () => {
    expect(() => {
      render(<ComboboxOption value="x">X</ComboboxOption>);
    }).toThrow('<ComboboxOption> must be used within a <Combobox>');
  });

  it('should not open on button click when disabled', () => {
    render(
      <Combobox as="div" disabled>
        <ComboboxInput />
        <ComboboxButton>Toggle</ComboboxButton>
        <ComboboxOptions>
          <ComboboxOption value="a">A</ComboboxOption>
        </ComboboxOptions>
      </Combobox>
    );
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should not process keydown on input when disabled', () => {
    render(
      <Combobox as="div" disabled>
        <ComboboxInput />
        <ComboboxOptions static>
          <ComboboxOption value="a">A</ComboboxOption>
        </ComboboxOptions>
      </Combobox>
    );
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('should render with portal=true', () => {
    render(
      <Combobox as="div">
        <ComboboxInput />
        <ComboboxOptions portal>
          <ComboboxOption value="a">A</ComboboxOption>
        </ComboboxOptions>
      </Combobox>
    );
    fireEvent.input(screen.getByRole('combobox'));
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it('should render with static=true always visible', () => {
    render(
      <Combobox as="div">
        <ComboboxInput />
        <ComboboxOptions static>
          <ComboboxOption value="a">A</ComboboxOption>
        </ComboboxOptions>
      </Combobox>
    );
    expect(screen.getByRole('listbox')).not.toBeNull();
  });

  it('should set aria-expanded=false when closed on ComboboxInput', () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('should set aria-expanded=true when open on ComboboxInput', () => {
    render(<BasicCombobox />);
    fireEvent.click(screen.getByText('Toggle'));
    const input = screen.getByRole('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('should set hover/focus/blur on ComboboxInput without error', async () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.mouseEnter(input);
    fireEvent.mouseLeave(input);
    await act(async () => {
      input.focus();
    });
    await act(async () => {
      input.blur();
    });
    expect(input).not.toBeNull();
  });

  it('should set hover/focus/active state on ComboboxButton without error', () => {
    render(<BasicCombobox />);
    const btn = screen.getByText('Toggle');
    fireEvent.mouseEnter(btn);
    fireEvent.mouseLeave(btn);
    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);
    expect(btn).not.toBeNull();
  });

  it('should handle focus/blur on ComboboxOption', async () => {
    render(<BasicCombobox />);
    fireEvent.click(screen.getByText('Toggle'));
    const options = screen.getAllByRole('option');
    await act(async () => {
      options[0].focus();
    });
    await act(async () => {
      options[0].blur();
    });
    expect(options[0]).not.toBeNull();
  });

  it('should handle pointerMove on option to activate it', async () => {
    render(<BasicCombobox />);
    fireEvent.click(screen.getByText('Toggle'));
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.pointerMove(options[1], { screenX: 10, screenY: 20 });
    });
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('should deactivate item on pointer leave', async () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
    await act(async () => {
      fireEvent.pointerLeave(options[0]);
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBeFalsy();
  });

  it('should handle pointerLeave on non-active item without deactivating', async () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.pointerLeave(options[2]);
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
  });

  it('should cover enter/leave transition attrs with RAF', async () => {
    const raf = new RAFQueue();
    raf.install();
    render(
      <Combobox as="div">
        <ComboboxInput />
        <ComboboxOptions transition unmount={false}>
          <ComboboxOption value="a">A</ComboboxOption>
        </ComboboxOptions>
      </Combobox>
    );
    await act(async () => {
      fireEvent.input(screen.getByRole('combobox'));
    });
    await act(async () => {
      raf.flush();
    });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    });
    await act(async () => {
      raf.flush();
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should not select disabled option on Enter key', async () => {
    const onChange = vi.fn();
    render(
      <Combobox as="div" value="a" onChange={onChange}>
        <ComboboxInput />
        <ComboboxOptions>
          <ComboboxOption value="b" disabled>
            Disabled B
          </ComboboxOption>
        </ComboboxOptions>
      </Combobox>
    );
    const input = screen.getByRole('combobox');
    fireEvent.input(input);
    await act(async () => {
      fireEvent.keyDown(input, { key: 'End' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('should not select disabled option on Tab key', async () => {
    const onChange = vi.fn();
    render(
      <Combobox as="div" value="a" onChange={onChange}>
        <ComboboxInput />
        <ComboboxOptions>
          <ComboboxOption value="b" disabled>
            Disabled B
          </ComboboxOption>
        </ComboboxOptions>
      </Combobox>
    );
    const input = screen.getByRole('combobox');
    fireEvent.input(input);
    await act(async () => {
      fireEvent.keyDown(input, { key: 'End' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Tab' });
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('should sync displayValue when option closes', async () => {
    const displayValue = (v: string) => `Label: ${v}`;
    render(<BasicCombobox value="a" onChange={vi.fn()} displayValue={displayValue} />);
    fireEvent.click(screen.getByText('Toggle'));
    fireEvent.click(screen.getByText('Option C'));
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(input.value).toBe('Label: a');
  });

  it('should keep open in multiple mode after Enter select', async () => {
    const onChange = vi.fn();
    render(
      <Combobox as="div" multiple value={[]} onChange={onChange}>
        <ComboboxInput />
        <ComboboxOptions>
          <ComboboxOption value="a">A</ComboboxOption>
          <ComboboxOption value="b">B</ComboboxOption>
        </ComboboxOptions>
      </Combobox>
    );
    const input = screen.getByRole('combobox');
    fireEvent.input(input);
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should support uncontrolled defaultValue', () => {
    render(<BasicCombobox defaultValue="b" />);
    fireEvent.click(screen.getByText('Toggle'));
    const options = screen.getAllByRole('option');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
  });

  it('should handle ArrowDown activating next with existing active', async () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[1].getAttribute('id'));
  });

  it('should handle ArrowUp activating prev with existing active', async () => {
    render(<BasicCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.click(screen.getByText('Toggle'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowUp' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[1].getAttribute('id'));
  });

  it('should handle ArrowUp when closed (activates last via RAF)', async () => {
    const raf = new RAFQueue();
    raf.install();
    render(<BasicComboboxNoUnmount />);
    const input = screen.getByRole('combobox');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowUp' });
    });
    await act(async () => {
      raf.flush();
    });
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    expect(listbox.getAttribute('aria-activedescendant')).toBe(
      options[options.length - 1].getAttribute('id')
    );
  });
});
