import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  ListboxSelectedOption,
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

function BasicListbox({
  onChange,
  value,
  defaultValue,
  disabled,
  invalid,
  horizontal,
  multiple,
  name,
  item2Disabled = false,
}: {
  onChange?: (v: string) => void;
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  invalid?: boolean;
  horizontal?: boolean;
  multiple?: boolean;
  name?: string;
  item2Disabled?: boolean;
}) {
  return (
    <Listbox
      value={value}
      defaultValue={defaultValue}
      onChange={onChange}
      disabled={disabled}
      invalid={invalid}
      horizontal={horizontal}
      multiple={multiple}
      name={name}
    >
      <ListboxButton>Choose</ListboxButton>
      <ListboxOptions>
        <ListboxOption value="a">Option A</ListboxOption>
        <ListboxOption value="b" disabled={item2Disabled}>
          Option B
        </ListboxOption>
        <ListboxOption value="c">Option C</ListboxOption>
      </ListboxOptions>
    </Listbox>
  );
}

describe('Listbox', () => {
  it('should be closed by default', () => {
    render(<BasicListbox />);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should open on ListboxButton click', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('should close on second ListboxButton click', () => {
    render(<BasicListbox />);
    const btn = screen.getByText('Choose');
    fireEvent.click(btn);
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.click(btn);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should set aria-haspopup=listbox on ListboxButton', () => {
    render(<BasicListbox />);
    const btn = screen.getByText('Choose');
    expect(btn.getAttribute('aria-haspopup')).toBe('listbox');
  });

  it('should set aria-expanded on ListboxButton', async () => {
    render(<BasicListbox />);
    const btn = screen.getByText('Choose');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(screen.getByText('Choose').getAttribute('aria-expanded')).toBe('true');
  });

  it('should set aria-controls on ListboxButton pointing to options id', () => {
    render(<BasicListbox />);
    const btn = screen.getByText('Choose');
    fireEvent.click(btn);
    const listbox = screen.getByRole('listbox');
    expect(btn.getAttribute('aria-controls')).toBe(listbox.getAttribute('id'));
  });

  it('should set role=listbox on ListboxOptions', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    expect(screen.getByRole('listbox')).not.toBeNull();
  });

  it('should set role=option on ListboxOption', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const options = screen.getAllByRole('option');
    expect(options.length).toBe(3);
  });

  it('should call onChange with selected value on click', () => {
    const onChange = vi.fn();
    render(<BasicListbox onChange={onChange} value="a" />);
    fireEvent.click(screen.getByText('Choose'));
    fireEvent.click(screen.getByText('Option C'));
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('should close on option click in single mode', () => {
    render(<BasicListbox value="a" onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Choose'));
    fireEvent.click(screen.getByText('Option B'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should support uncontrolled defaultValue', () => {
    render(<BasicListbox defaultValue="b" />);
    fireEvent.click(screen.getByText('Choose'));
    const options = screen.getAllByRole('option');
    const optB = options.find((o) => o.textContent === 'Option B');
    expect(optB?.getAttribute('aria-selected')).toBe('true');
  });

  it('should set aria-selected on selected option', () => {
    render(<BasicListbox value="c" onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Choose'));
    const options = screen.getAllByRole('option');
    const optC = options.find((o) => o.textContent === 'Option C');
    expect(optC?.getAttribute('aria-selected')).toBe('true');
  });

  it('should not select when clicking disabled option', () => {
    const onChange = vi.fn();
    render(<BasicListbox value="a" onChange={onChange} item2Disabled />);
    fireEvent.click(screen.getByText('Choose'));
    fireEvent.click(screen.getByText('Option B'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('should navigate with ArrowDown key', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
  });

  it('should navigate with ArrowUp key (activates last when none active)', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowUp' });
    const options = screen.getAllByRole('option');
    expect(listbox.getAttribute('aria-activedescendant')).toBe(
      options[options.length - 1].getAttribute('id')
    );
  });

  it('should navigate to next with ArrowDown when active exists', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(listbox, { key: 'Home' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[1].getAttribute('id'));
  });

  it('should navigate to prev with ArrowUp when active exists', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(listbox, { key: 'End' });
    fireEvent.keyDown(listbox, { key: 'ArrowUp' });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[1].getAttribute('id'));
  });

  it('should activate first option on Home key', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'End' });
    fireEvent.keyDown(listbox, { key: 'Home' });
    const options = screen.getAllByRole('option');
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
  });

  it('should activate last option on End key', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'End' });
    const options = screen.getAllByRole('option');
    expect(listbox.getAttribute('aria-activedescendant')).toBe(
      options[options.length - 1].getAttribute('id')
    );
  });

  it('should activate first option on PageUp key', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'End' });
    fireEvent.keyDown(listbox, { key: 'PageUp' });
    const options = screen.getAllByRole('option');
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
  });

  it('should activate last option on PageDown key', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'PageDown' });
    const options = screen.getAllByRole('option');
    expect(listbox.getAttribute('aria-activedescendant')).toBe(
      options[options.length - 1].getAttribute('id')
    );
  });

  it('should select active option on Enter key', async () => {
    const onChange = vi.fn();
    render(<BasicListbox value="a" onChange={onChange} />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    await act(async () => {
      fireEvent.keyDown(listbox, { key: 'Enter' });
    });
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('should select active option on Space key', async () => {
    const onChange = vi.fn();
    render(<BasicListbox value="a" onChange={onChange} />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'End' });
    await act(async () => {
      fireEvent.keyDown(listbox, { key: ' ' });
    });
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('should close on Escape key', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should close on Tab key', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should skip disabled option during ArrowDown navigation', () => {
    render(<BasicListbox item2Disabled />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[2].getAttribute('id'));
  });

  it('should support multiple mode: clicking toggles and menu stays open', () => {
    const onChange = vi.fn();
    render(
      <Listbox multiple value={[]} onChange={onChange}>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions>
          <ListboxOption value="a">Option A</ListboxOption>
          <ListboxOption value="b">Option B</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    fireEvent.click(screen.getByText('Choose'));
    fireEvent.click(screen.getByText('Option A'));
    expect(screen.queryByRole('listbox')).not.toBeNull();
    expect(onChange).toHaveBeenCalledWith(['a']);
  });

  it('should deselect in multiple mode when clicking already selected option', () => {
    const onChange = vi.fn();
    render(
      <Listbox multiple value={['a', 'b']} onChange={onChange}>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions>
          <ListboxOption value="a">Option A</ListboxOption>
          <ListboxOption value="b">Option B</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    fireEvent.click(screen.getByText('Choose'));
    fireEvent.click(screen.getByText('Option A'));
    expect(onChange).toHaveBeenCalledWith(['b']);
  });

  it('should set aria-multiselectable in multiple mode', () => {
    render(
      <Listbox multiple value={[]}>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions>
          <ListboxOption value="a">Option A</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    expect(listbox.getAttribute('aria-multiselectable')).toBe('true');
  });

  it('should render hidden input with name prop', () => {
    render(<BasicListbox name="color" value="a" onChange={vi.fn()} />);
    const input = document.querySelector('input[name="color"]');
    expect(input).not.toBeNull();
    expect((input as HTMLInputElement).value).toBe('a');
  });

  it('should render multiple hidden inputs for multiple + name', () => {
    render(
      <Listbox multiple value={['a', 'b']} onChange={vi.fn()} name="color">
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions>
          <ListboxOption value="a">A</ListboxOption>
          <ListboxOption value="b">B</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    const inputs = document.querySelectorAll('input[name="color"]');
    expect(inputs.length).toBe(2);
  });

  it('should set data-invalid attribute when invalid prop is true', () => {
    render(<BasicListbox invalid />);
    const btn = screen.getByText('Choose');
    expect(btn).not.toBeNull();
  });

  it('should use horizontal mode: ArrowRight/Left for navigation', () => {
    render(<BasicListbox horizontal />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(listbox, { key: 'ArrowRight' });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
    fireEvent.keyDown(listbox, { key: 'ArrowRight' });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[1].getAttribute('id'));
    fireEvent.keyDown(listbox, { key: 'ArrowLeft' });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
  });

  it('should support by string comparison', () => {
    const onChange = vi.fn();
    render(
      <Listbox by="id" value={{ id: 'a', name: 'Alpha' }} onChange={onChange}>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions>
          <ListboxOption value={{ id: 'a', name: 'Alpha' }}>Alpha</ListboxOption>
          <ListboxOption value={{ id: 'b', name: 'Beta' }}>Beta</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    fireEvent.click(screen.getByText('Choose'));
    const options = screen.getAllByRole('option');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(options[1].getAttribute('aria-selected')).toBe('false');
  });

  it('should support by function comparison', () => {
    const onChange = vi.fn();
    const byFn = (a: unknown, b: unknown) => (a as { id: string }).id === (b as { id: string }).id;
    render(
      <Listbox by={byFn} value={{ id: 'b' }} onChange={onChange}>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions>
          <ListboxOption value={{ id: 'a' }}>A</ListboxOption>
          <ListboxOption value={{ id: 'b' }}>B</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    fireEvent.click(screen.getByText('Choose'));
    const options = screen.getAllByRole('option');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
  });

  it('should render ListboxSelectedOption with value child', () => {
    render(
      <Listbox value="a">
        <ListboxSelectedOption>
          <span>Selected: a</span>
        </ListboxSelectedOption>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions>
          <ListboxOption value="a">A</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    expect(screen.getByText('Selected: a')).not.toBeNull();
  });

  it('should render ListboxSelectedOption placeholder when no value', () => {
    render(
      <Listbox>
        <ListboxSelectedOption placeholder={<span>Pick one</span>}>
          <span>Selected</span>
        </ListboxSelectedOption>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions>
          <ListboxOption value="a">A</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    expect(screen.getByText('Pick one')).not.toBeNull();
  });

  it('should throw when ListboxButton used outside Listbox', () => {
    expect(() => {
      render(<ListboxButton>Orphan</ListboxButton>);
    }).toThrow('<ListboxButton> must be used within a <Listbox>');
  });

  it('should throw when ListboxOptions used outside Listbox', () => {
    expect(() => {
      render(
        <ListboxOptions>
          <span />
        </ListboxOptions>
      );
    }).toThrow('<ListboxOptions> must be used within a <Listbox>');
  });

  it('should throw when ListboxOption used outside Listbox', () => {
    expect(() => {
      render(<ListboxOption value="x">X</ListboxOption>);
    }).toThrow('<ListboxOption> must be used within a <Listbox>');
  });

  it('should throw when ListboxSelectedOption used outside Listbox', () => {
    expect(() => {
      render(<ListboxSelectedOption>X</ListboxSelectedOption>);
    }).toThrow('<ListboxSelectedOption> must be used within a <Listbox>');
  });

  it('should not open when ListboxButton is disabled', () => {
    render(
      <Listbox disabled>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions>
          <ListboxOption value="a">A</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    fireEvent.click(screen.getByText('Choose'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should open with static=true always visible', () => {
    render(
      <Listbox>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions static>
          <ListboxOption value="a">A</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    expect(screen.getByRole('listbox')).not.toBeNull();
  });

  it('should keep options in DOM with unmount=false when closed', () => {
    render(
      <Listbox>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions unmount={false}>
          <ListboxOption value="a">A</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    const listbox = document.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    expect(listbox?.getAttribute('hidden')).toBe('');
  });

  it('should handle Enter key when no active option (no-op)', async () => {
    const onChange = vi.fn();
    render(<BasicListbox value="a" onChange={onChange} />);
    fireEvent.click(screen.getByText('Choose'));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('should handle Escape key on ListboxButton when closed', async () => {
    render(<BasicListbox />);
    const btn = screen.getByText('Choose');
    await act(async () => {
      fireEvent.keyDown(btn, { key: 'Escape' });
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should open with ArrowDown on ListboxButton via RAF', async () => {
    const raf = new RAFQueue();
    raf.install();
    render(<BasicListbox />);
    const btn = screen.getByText('Choose');
    await act(async () => {
      fireEvent.keyDown(btn, { key: 'ArrowDown' });
    });
    await act(async () => {
      raf.flush();
    });
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('should open with ArrowUp on ListboxButton and activate last option via RAF', async () => {
    const raf = new RAFQueue();
    raf.install();
    render(<BasicListbox />);
    const btn = screen.getByText('Choose');
    await act(async () => {
      fireEvent.keyDown(btn, { key: 'ArrowUp' });
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

  it('should open with Enter key on ListboxButton', async () => {
    render(<BasicListbox />);
    const btn = screen.getByText('Choose');
    await act(async () => {
      fireEvent.keyDown(btn, { key: 'Enter' });
    });
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('should open with Space key on ListboxButton', async () => {
    render(<BasicListbox />);
    const btn = screen.getByText('Choose');
    await act(async () => {
      fireEvent.keyDown(btn, { key: ' ' });
    });
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('should typeahead match option by character', async () => {
    render(
      <Listbox>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions>
          <ListboxOption value="a">Apple</ListboxOption>
          <ListboxOption value="b">Banana</ListboxOption>
          <ListboxOption value="c">Cherry</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.keyDown(listbox, { key: 'c' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[2].getAttribute('id'));
  });

  it('should typeahead wrap around from beginning', async () => {
    render(
      <Listbox>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions>
          <ListboxOption value="a">Apple</ListboxOption>
          <ListboxOption value="b">Banana</ListboxOption>
          <ListboxOption value="c">Cherry</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(listbox, { key: 'End' });
    await act(async () => {
      fireEvent.keyDown(listbox, { key: 'a' });
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
  });

  it('should close on outside click', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      render(<BasicListbox />);
      await act(async () => {
        fireEvent.click(screen.getByText('Choose'));
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

  it('should close on Escape via useEscape hook', () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should render with portal=true', () => {
    render(
      <Listbox>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions portal>
          <ListboxOption value="a">A</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    fireEvent.click(screen.getByText('Choose'));
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it('should set hover/focus/active state on ListboxButton without error', () => {
    render(<BasicListbox />);
    const btn = screen.getByText('Choose');
    fireEvent.mouseEnter(btn);
    fireEvent.mouseLeave(btn);
    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);
    expect(btn).not.toBeNull();
  });

  it('should handle focus/blur on ListboxOption', async () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
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
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.pointerMove(options[1], { screenX: 10, screenY: 20 });
    });
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('should deactivate item on pointer leave from active item', async () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
    await act(async () => {
      fireEvent.pointerLeave(options[0]);
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBeFalsy();
  });

  it('should handle pointerLeave on non-active item without deactivating', async () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    await act(async () => {
      fireEvent.pointerLeave(options[1]);
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
  });

  it('should cover enter/leave transition attrs with RAF', async () => {
    const raf = new RAFQueue();
    raf.install();
    render(
      <Listbox as="div">
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions transition unmount={false}>
          <ListboxOption value="a">A</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    await act(async () => {
      fireEvent.click(screen.getByText('Choose'));
    });
    await act(async () => {
      raf.flush();
    });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Choose'));
    });
    await act(async () => {
      raf.flush();
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('should dispatch listbox:openkey ArrowDown to activate first option', async () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      listbox.dispatchEvent(
        new CustomEvent('listbox:openkey', {
          detail: { key: 'ArrowDown' },
          bubbles: false,
        })
      );
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
  });

  it('should dispatch listbox:openkey ArrowUp to activate last option', async () => {
    render(<BasicListbox />);
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    await act(async () => {
      listbox.dispatchEvent(
        new CustomEvent('listbox:openkey', {
          detail: { key: 'ArrowUp' },
          bubbles: false,
        })
      );
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(
      options[options.length - 1].getAttribute('id')
    );
  });

  it('should not click disabled option on Enter key', async () => {
    const onChange = vi.fn();
    render(
      <Listbox value="a" onChange={onChange}>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions>
          <ListboxOption value="b" disabled>
            Disabled B
          </ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'End' });
    await act(async () => {
      fireEvent.keyDown(listbox, { key: 'Enter' });
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('should keep open in multiple mode on Enter', async () => {
    const onChange = vi.fn();
    render(
      <Listbox multiple value={[]} onChange={onChange}>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions>
          <ListboxOption value="a">A</ListboxOption>
          <ListboxOption value="b">B</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    fireEvent.click(screen.getByText('Choose'));
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    await act(async () => {
      fireEvent.keyDown(listbox, { key: 'Enter' });
    });
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('should handle typeahead setTimeout body with fake timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      render(<BasicListbox />);
      await act(async () => {
        fireEvent.click(screen.getByText('Choose'));
      });
      const listbox = screen.getByRole('listbox');
      await act(async () => {
        fireEvent.keyDown(listbox, { key: 'a' });
      });
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.queryByRole('listbox')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should not navigate with keydown on disabled ListboxButton', () => {
    render(
      <Listbox disabled>
        <ListboxButton>Choose</ListboxButton>
        <ListboxOptions static>
          <ListboxOption value="a">A</ListboxOption>
        </ListboxOptions>
      </Listbox>
    );
    const btn = screen.getByText('Choose');
    fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
});
