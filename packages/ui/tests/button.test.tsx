import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { createElement } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloseButton } from '../src/components/button/button.tsx';
import { CloseContext } from '../src/hooks/use-close.ts';
import { Button, ButtonGroup, DataInteractive } from '../src/mod.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Button', () => {
  it('should render a button by default', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button')).not.toBeNull();
  });

  it('should set type=button automatically', () => {
    render(<Button>Click</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('should allow overriding type', () => {
    render(<Button type="submit">Submit</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('submit');
  });

  it('should render children', () => {
    render(<Button>Hello</Button>);
    expect(screen.getByText('Hello')).not.toBeNull();
  });

  it('should render with custom as prop (anchor)', () => {
    render(
      <Button as="a" href="#">
        Link
      </Button>
    );
    const link = screen.getByRole('link');
    expect(link).not.toBeNull();
    expect(link.getAttribute('type')).toBeNull();
  });

  it('should render as div with as="div"', () => {
    const { container } = render(<Button as="div">Div Button</Button>);
    expect(container.querySelector('div')).not.toBeNull();
  });

  it('should be disabled when disabled=true', () => {
    render(<Button disabled>Disabled</Button>);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('should set data-hover on pointer enter (non-touch)', async () => {
    render(<Button>Hover me</Button>);
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.pointerEnter(btn, { pointerType: 'mouse' });
    });
    expect(btn.getAttribute('data-hover')).toBe('');
  });

  it('should remove data-hover on pointer leave (non-touch)', async () => {
    render(<Button>Hover me</Button>);
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.pointerEnter(btn, { pointerType: 'mouse' });
    });
    expect(btn.getAttribute('data-hover')).toBe('');
    await act(async () => {
      fireEvent.pointerLeave(btn, { pointerType: 'mouse' });
    });
    expect(btn.getAttribute('data-hover')).toBeNull();
  });

  it('should not set data-hover on touch pointer enter', async () => {
    render(<Button>Touch me</Button>);
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.pointerEnter(btn, { pointerType: 'touch' });
    });
    expect(btn.getAttribute('data-hover')).toBeNull();
  });

  it('should not set data-hover on touch pointer leave', async () => {
    render(<Button>Touch me</Button>);
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.pointerEnter(btn, { pointerType: 'mouse' });
    });
    await act(async () => {
      fireEvent.pointerLeave(btn, { pointerType: 'touch' });
    });
    expect(btn.getAttribute('data-hover')).toBe('');
  });

  it('should set data-focus on focus (non-touch)', async () => {
    render(<Button>Focus me</Button>);
    const btn = screen.getByRole('button');
    await act(async () => {
      btn.focus();
    });
    expect(btn.getAttribute('data-focus')).toBe('');
  });

  it('should remove data-focus on blur', async () => {
    render(<Button>Focus me</Button>);
    const btn = screen.getByRole('button');
    await act(async () => {
      btn.focus();
    });
    expect(btn.getAttribute('data-focus')).toBe('');
    await act(async () => {
      btn.blur();
    });
    expect(btn.getAttribute('data-focus')).toBeNull();
  });

  it('should not set data-focus when sourceCapabilities.firesTouchEvents=true', async () => {
    render(<Button>Touch Focus</Button>);
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.focus(btn, {
        sourceCapabilities: { firesTouchEvents: true },
      });
    });
    expect(btn.getAttribute('data-focus')).toBeNull();
  });

  it('should not set data-focus after touch pointer down', async () => {
    render(<Button>Touch Active</Button>);
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.pointerDown(btn, { pointerType: 'touch' });
    });
    await act(async () => {
      fireEvent.focus(btn);
    });
    expect(btn.getAttribute('data-focus')).toBeNull();
  });

  it('should set data-active on pointer down', async () => {
    render(<Button>Active</Button>);
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.pointerDown(btn, { pointerType: 'mouse' });
    });
    expect(btn.getAttribute('data-active')).toBe('');
  });

  it('should remove data-active on pointer up', async () => {
    render(<Button>Active</Button>);
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.pointerDown(btn, { pointerType: 'mouse' });
    });
    expect(btn.getAttribute('data-active')).toBe('');
    await act(async () => {
      fireEvent.pointerUp(btn);
    });
    expect(btn.getAttribute('data-active')).toBeNull();
  });

  it('should set data-disabled when disabled', () => {
    render(<Button disabled>Disabled Btn</Button>);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('data-disabled')).toBe('');
  });

  it('should not set data-disabled when not disabled', () => {
    render(<Button>Normal Btn</Button>);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('data-disabled')).toBeNull();
  });

  it('should pass through extra props', () => {
    render(<Button data-testid="my-btn">btn</Button>);
    expect(screen.getByTestId('my-btn')).not.toBeNull();
  });
});

describe('CloseButton', () => {
  it('should render a button by default', () => {
    render(
      createElement(
        CloseContext.Provider,
        { value: () => {} },
        createElement(CloseButton, null, 'Close')
      )
    );
    expect(screen.getByRole('button')).not.toBeNull();
  });

  it('should call close from CloseContext when clicked', () => {
    const closeFn = vi.fn();
    render(
      createElement(
        CloseContext.Provider,
        { value: closeFn },
        createElement(CloseButton, null, 'Close')
      )
    );
    fireEvent.click(screen.getByRole('button'));
    expect(closeFn).toHaveBeenCalled();
  });

  it('should not throw when close is null (no context)', () => {
    expect(() => {
      render(
        createElement(
          CloseContext.Provider,
          { value: null },
          createElement(CloseButton, null, 'Close')
        )
      );
    }).not.toThrow();
  });

  it('should set type=button when as=button', () => {
    render(
      createElement(
        CloseContext.Provider,
        { value: () => {} },
        createElement(CloseButton, null, 'Close')
      )
    );
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('should not set type when as is not button', () => {
    render(
      createElement(
        CloseContext.Provider,
        { value: () => {} },
        createElement(CloseButton, { as: 'a', href: '#' }, 'Close')
      )
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('type')).toBeNull();
  });

  it('should set data-hover on pointer enter (non-touch)', async () => {
    render(
      createElement(
        CloseContext.Provider,
        { value: () => {} },
        createElement(CloseButton, null, 'Close')
      )
    );
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.pointerEnter(btn, { pointerType: 'mouse' });
    });
    expect(btn.getAttribute('data-hover')).toBe('');
  });

  it('should not set data-hover on touch pointer enter', async () => {
    render(
      createElement(
        CloseContext.Provider,
        { value: () => {} },
        createElement(CloseButton, null, 'Close')
      )
    );
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.pointerEnter(btn, { pointerType: 'touch' });
    });
    expect(btn.getAttribute('data-hover')).toBeNull();
  });

  it('should set data-focus on focus (non-touch)', async () => {
    render(
      createElement(
        CloseContext.Provider,
        { value: () => {} },
        createElement(CloseButton, null, 'Close')
      )
    );
    const btn = screen.getByRole('button');
    await act(async () => {
      btn.focus();
    });
    expect(btn.getAttribute('data-focus')).toBe('');
  });

  it('should remove data-focus on blur', async () => {
    render(
      createElement(
        CloseContext.Provider,
        { value: () => {} },
        createElement(CloseButton, null, 'Close')
      )
    );
    const btn = screen.getByRole('button');
    await act(async () => {
      btn.focus();
    });
    await act(async () => {
      btn.blur();
    });
    expect(btn.getAttribute('data-focus')).toBeNull();
  });

  it('should set data-active on pointer down', async () => {
    render(
      createElement(
        CloseContext.Provider,
        { value: () => {} },
        createElement(CloseButton, null, 'Close')
      )
    );
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.pointerDown(btn, { pointerType: 'mouse' });
    });
    expect(btn.getAttribute('data-active')).toBe('');
  });

  it('should remove data-active on pointer up', async () => {
    render(
      createElement(
        CloseContext.Provider,
        { value: () => {} },
        createElement(CloseButton, null, 'Close')
      )
    );
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.pointerDown(btn, { pointerType: 'mouse' });
    });
    await act(async () => {
      fireEvent.pointerUp(btn);
    });
    expect(btn.getAttribute('data-active')).toBeNull();
  });

  it('should not set data-focus after touch pointer down', async () => {
    render(
      createElement(
        CloseContext.Provider,
        { value: () => {} },
        createElement(CloseButton, null, 'Close')
      )
    );
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.pointerDown(btn, { pointerType: 'touch' });
    });
    await act(async () => {
      fireEvent.focus(btn);
    });
    expect(btn.getAttribute('data-focus')).toBeNull();
  });

  it('should not set data-focus when sourceCapabilities.firesTouchEvents=true', async () => {
    render(
      createElement(
        CloseContext.Provider,
        { value: () => {} },
        createElement(CloseButton, null, 'Close')
      )
    );
    const btn = screen.getByRole('button');
    await act(async () => {
      fireEvent.focus(btn, { sourceCapabilities: { firesTouchEvents: true } });
    });
    expect(btn.getAttribute('data-focus')).toBeNull();
  });
});

describe('DataInteractive', () => {
  it('should render a div by default', () => {
    const { container } = render(<DataInteractive>content</DataInteractive>);
    expect(container.querySelector('div')).not.toBeNull();
  });

  it('should render with custom as prop', () => {
    const { container } = render(<DataInteractive as="span">content</DataInteractive>);
    expect(container.querySelector('span')).not.toBeNull();
  });

  it('should render children', () => {
    render(<DataInteractive>Hello World</DataInteractive>);
    expect(screen.getByText('Hello World')).not.toBeNull();
  });

  it('should set data-hover on pointer enter (non-touch)', async () => {
    const { container } = render(<DataInteractive>Hover</DataInteractive>);
    const el = container.querySelector('div') as HTMLElement;
    await act(async () => {
      fireEvent.pointerEnter(el, { pointerType: 'mouse' });
    });
    expect(el.getAttribute('data-hover')).toBe('');
  });

  it('should remove data-hover on pointer leave (non-touch)', async () => {
    const { container } = render(<DataInteractive>Hover</DataInteractive>);
    const el = container.querySelector('div') as HTMLElement;
    await act(async () => {
      fireEvent.pointerEnter(el, { pointerType: 'mouse' });
    });
    await act(async () => {
      fireEvent.pointerLeave(el, { pointerType: 'mouse' });
    });
    expect(el.getAttribute('data-hover')).toBeNull();
  });

  it('should not set data-hover on touch pointer enter', async () => {
    const { container } = render(<DataInteractive>Touch</DataInteractive>);
    const el = container.querySelector('div') as HTMLElement;
    await act(async () => {
      fireEvent.pointerEnter(el, { pointerType: 'touch' });
    });
    expect(el.getAttribute('data-hover')).toBeNull();
  });

  it('should not remove data-hover on touch pointer leave', async () => {
    const { container } = render(<DataInteractive>Touch</DataInteractive>);
    const el = container.querySelector('div') as HTMLElement;
    await act(async () => {
      fireEvent.pointerEnter(el, { pointerType: 'mouse' });
    });
    await act(async () => {
      fireEvent.pointerLeave(el, { pointerType: 'touch' });
    });
    expect(el.getAttribute('data-hover')).toBe('');
  });

  it('should set data-focus on focus (non-touch)', async () => {
    const { container } = render(<DataInteractive>Focus</DataInteractive>);
    const el = container.querySelector('div') as HTMLElement;
    await act(async () => {
      el.focus();
    });
    expect(el.getAttribute('data-focus')).toBe('');
  });

  it('should remove data-focus on blur', async () => {
    const { container } = render(<DataInteractive>Focus</DataInteractive>);
    const el = container.querySelector('div') as HTMLElement;
    await act(async () => {
      el.focus();
    });
    await act(async () => {
      el.blur();
    });
    expect(el.getAttribute('data-focus')).toBeNull();
  });

  it('should not set data-focus when sourceCapabilities.firesTouchEvents=true', async () => {
    const { container } = render(<DataInteractive>Touch Focus</DataInteractive>);
    const el = container.querySelector('div') as HTMLElement;
    await act(async () => {
      fireEvent.focus(el, { sourceCapabilities: { firesTouchEvents: true } });
    });
    expect(el.getAttribute('data-focus')).toBeNull();
  });

  it('should not set data-focus after touch pointer down', async () => {
    const { container } = render(<DataInteractive>Touch Active</DataInteractive>);
    const el = container.querySelector('div') as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(el, { pointerType: 'touch' });
    });
    await act(async () => {
      el.focus();
    });
    expect(el.getAttribute('data-focus')).toBeNull();
  });

  it('should set isTouch=false on mouse pointer down (focus should work after)', async () => {
    const { container } = render(<DataInteractive>Mouse</DataInteractive>);
    const el = container.querySelector('div') as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(el, { pointerType: 'mouse' });
    });
    await act(async () => {
      el.focus();
    });
    expect(el.getAttribute('data-focus')).toBe('');
  });

  it('should pass through extra props', () => {
    render(<DataInteractive data-testid="di">content</DataInteractive>);
    expect(screen.getByTestId('di')).not.toBeNull();
  });
});

describe('ButtonGroup', () => {
  it('should render a div by default', () => {
    const { container } = render(<ButtonGroup>Group content</ButtonGroup>);
    expect(container.querySelector('div')).not.toBeNull();
  });

  it('should have role="group"', () => {
    const { container } = render(<ButtonGroup>Group</ButtonGroup>);
    expect(container.querySelector('[role="group"]')).not.toBeNull();
  });

  it('should render children', () => {
    render(
      <ButtonGroup>
        <button>Button 1</button>
        <button>Button 2</button>
      </ButtonGroup>
    );
    expect(screen.getByText('Button 1')).not.toBeNull();
    expect(screen.getByText('Button 2')).not.toBeNull();
  });

  it('should render multiple buttons as a group', () => {
    render(
      <ButtonGroup>
        <Button>Save</Button>
        <Button>Cancel</Button>
        <Button>Delete</Button>
      </ButtonGroup>
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
    const group = buttons[0].parentElement;
    expect(group?.getAttribute('role')).toBe('group');
  });

  it('should have data-slot="button-group"', () => {
    const { container } = render(<ButtonGroup>Group</ButtonGroup>);
    expect(container.querySelector('[data-slot="button-group"]')).not.toBeNull();
  });

  it('should support aria-label for accessibility', () => {
    const { container } = render(<ButtonGroup aria-label="Button actions">Group</ButtonGroup>);
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Button actions');
  });

  it('should render with custom as prop', () => {
    const { container } = render(<ButtonGroup as="span">Group</ButtonGroup>);
    expect(container.querySelector('span[role="group"]')).not.toBeNull();
  });

  it('should pass through extra props', () => {
    render(<ButtonGroup data-testid="my-group">Group</ButtonGroup>);
    expect(screen.getByTestId('my-group')).not.toBeNull();
  });

  it('should render with id attribute', () => {
    const { container } = render(<ButtonGroup id="actions-group">Group</ButtonGroup>);
    expect(container.querySelector('#actions-group')).not.toBeNull();
  });

  it('should render with className', () => {
    const { container } = render(<ButtonGroup class="flex gap-2">Group</ButtonGroup>);
    const group = container.querySelector('[role="group"]');
    expect(group?.className).toContain('flex gap-2');
  });

  it('should support disabled state via props', () => {
    render(
      <ButtonGroup>
        <Button disabled>Disabled</Button>
      </ButtonGroup>
    );
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
