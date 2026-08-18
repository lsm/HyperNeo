import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { Input, InputAddon, InputGroup } from '../src/mod.ts';

afterEach(() => {
  cleanup();
});

describe('InputGroup', () => {
  it('should render a div by default', () => {
    const { container } = render(
      <InputGroup>
        <Input />
      </InputGroup>
    );
    expect(container.querySelector('div')).not.toBeNull();
  });

  it('should render with custom as prop', () => {
    const { container } = render(
      <InputGroup as="span">
        <Input />
      </InputGroup>
    );
    expect(container.querySelector('span')).not.toBeNull();
  });

  it('should render children', () => {
    render(
      <InputGroup>
        <InputAddon>https://</InputAddon>
        <Input />
      </InputGroup>
    );
    expect(screen.getByText('https://')).not.toBeNull();
  });

  it('should set data-hover on mouseenter', async () => {
    const { container } = render(
      <InputGroup>
        <InputAddon>$</InputAddon>
        <Input />
      </InputGroup>
    );
    const group = container.firstElementChild as HTMLElement;

    await act(async () => {
      fireEvent.mouseEnter(group);
    });
    expect(group.getAttribute('data-hover')).toBe('');

    await act(async () => {
      fireEvent.mouseLeave(group);
    });
    expect(group.getAttribute('data-hover')).toBeNull();
  });

  it('should set data-focus on focusin and clear on focusout', async () => {
    const { container } = render(
      <InputGroup>
        <InputAddon>$</InputAddon>
        <Input />
      </InputGroup>
    );
    const group = container.firstElementChild as HTMLElement;
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.focusIn(input);
    });
    expect(group.getAttribute('data-focus')).toBe('');

    await act(async () => {
      fireEvent.focusOut(input);
    });
    expect(group.getAttribute('data-focus')).toBeNull();
  });

  it('should provide context to InputAddon', async () => {
    const { container } = render(
      <InputGroup>
        <InputAddon>$</InputAddon>
        <Input />
      </InputGroup>
    );
    const addon = screen.getByText('$');
    expect(addon).not.toBeNull();
  });

  it('should set data-disabled when disabled prop is true', () => {
    const { container } = render(
      <InputGroup disabled>
        <InputAddon>$</InputAddon>
        <Input />
      </InputGroup>
    );
    const group = container.querySelector('[data-disabled]');
    expect(group).not.toBeNull();
  });
});

describe('InputAddon', () => {
  it('should render a div by default', () => {
    const { container } = render(<InputAddon>$</InputAddon>);
    expect(container.querySelector('div')).not.toBeNull();
  });

  it('should render children', () => {
    render(<InputAddon>https://</InputAddon>);
    expect(screen.getByText('https://')).not.toBeNull();
  });

  it('should render with custom as prop', () => {
    const { container } = render(<InputAddon as="span">Addon</InputAddon>);
    expect(container.querySelector('span')).not.toBeNull();
  });

  it('should render outside InputGroup (no context)', () => {
    render(<InputAddon>Standalone</InputAddon>);
    expect(screen.getByText('Standalone')).not.toBeNull();
  });

  it('should receive data-hover attribute from InputGroup context', async () => {
    const { container } = render(
      <InputGroup>
        <InputAddon>$</InputAddon>
        <Input />
      </InputGroup>
    );
    const group = container.firstElementChild as HTMLElement;
    const addon = screen.getByText('$');

    await act(async () => {
      fireEvent.mouseEnter(group);
    });
    expect(addon.getAttribute('data-hover')).toBe('');

    await act(async () => {
      fireEvent.mouseLeave(group);
    });
    expect(addon.getAttribute('data-hover')).toBeNull();
  });

  it('should receive data-focus attribute from InputGroup context', async () => {
    const { container } = render(
      <InputGroup>
        <InputAddon>$</InputAddon>
        <Input />
      </InputGroup>
    );
    const group = container.firstElementChild as HTMLElement;
    const addon = screen.getByText('$');

    await act(async () => {
      fireEvent.focusIn(group);
    });
    expect(addon.getAttribute('data-focus')).toBe('');

    await act(async () => {
      fireEvent.focusOut(group);
    });
    expect(addon.getAttribute('data-focus')).toBeNull();
  });

  it('should receive data-disabled attribute from InputGroup context', () => {
    render(
      <InputGroup disabled>
        <InputAddon>$</InputAddon>
        <Input />
      </InputGroup>
    );
    const addon = screen.getByText('$');
    expect(addon.getAttribute('data-disabled')).toBe('');
  });
});

describe('InputGroup + InputAddon + Input', () => {
  it('should render complete input group with addon', () => {
    render(
      <InputGroup>
        <InputAddon>https://</InputAddon>
        <Input />
      </InputGroup>
    );
    expect(screen.getByText('https://')).not.toBeNull();
    expect(screen.getByRole('textbox')).not.toBeNull();
  });

  it('should render input group with trailing addon', () => {
    render(
      <InputGroup>
        <Input />
        <InputAddon>.com</InputAddon>
      </InputGroup>
    );
    expect(screen.getByText('.com')).not.toBeNull();
    expect(screen.getByRole('textbox')).not.toBeNull();
  });

  it('should render input group with leading and trailing addons', () => {
    render(
      <InputGroup>
        <InputAddon>$</InputAddon>
        <Input />
        <InputAddon>USD</InputAddon>
      </InputGroup>
    );
    expect(screen.getByText('$')).not.toBeNull();
    expect(screen.getByRole('textbox')).not.toBeNull();
    expect(screen.getByText('USD')).not.toBeNull();
  });

  it('should work with custom className on InputGroup', () => {
    const { container } = render(
      <InputGroup className="flex items-center rounded-md">
        <InputAddon>$</InputAddon>
        <Input />
      </InputGroup>
    );
    const group = container.firstElementChild;
    expect(group?.classList.contains('flex')).toBe(true);
    expect(group?.classList.contains('items-center')).toBe(true);
    expect(group?.classList.contains('rounded-md')).toBe(true);
  });

  it('should render with disabled prop for styling', () => {
    const { container } = render(
      <InputGroup disabled>
        <InputAddon>$</InputAddon>
        <Input />
        <InputAddon>USD</InputAddon>
      </InputGroup>
    );
    const group = container.querySelector('[data-disabled]');
    expect(group).not.toBeNull();
  });
});
