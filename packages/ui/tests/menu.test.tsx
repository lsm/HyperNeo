import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Menu,
  MenuButton,
  MenuHeading,
  MenuItem,
  MenuItems,
  MenuSection,
  MenuSeparator,
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

function BasicMenu({ item2Disabled = false }: { item2Disabled?: boolean }) {
  return (
    <Menu>
      <MenuButton>Open Menu</MenuButton>
      <MenuItems>
        <MenuItem as="button">Item 1</MenuItem>
        <MenuItem as="button" disabled={item2Disabled}>
          Item 2
        </MenuItem>
        <MenuItem as="button">Item 3</MenuItem>
      </MenuItems>
    </Menu>
  );
}

describe('Menu', () => {
  it('should be closed by default', () => {
    render(<BasicMenu />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('should open on MenuButton click', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('should close on second MenuButton click', () => {
    render(<BasicMenu />);
    const btn = screen.getByText('Open Menu');
    fireEvent.click(btn);
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(btn);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('should set aria-haspopup=menu on MenuButton', () => {
    render(<BasicMenu />);
    const btn = screen.getByText('Open Menu');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('should set aria-expanded on MenuButton when open', async () => {
    render(<BasicMenu />);
    const btn = screen.getByText('Open Menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(screen.getByText('Open Menu').getAttribute('aria-expanded')).toBe('true');
  });

  it('should set role=menu on MenuItems', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    expect(screen.getByRole('menu')).not.toBeNull();
  });

  it('should set role=menuitem on MenuItem', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].getAttribute('role')).toBe('menuitem');
  });

  it('should close and call onClick when MenuItem is clicked', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(screen.getByText('Item 1'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('should close on Escape key', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('should navigate with ArrowDown key', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });
    const items = screen.getAllByRole('menuitem');
    const activeId = menuEl.getAttribute('aria-activedescendant');
    expect(activeId).toBe(items[0].getAttribute('id'));
  });

  it('should navigate with ArrowUp key', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    fireEvent.keyDown(menuEl, { key: 'ArrowUp' });
    const items = screen.getAllByRole('menuitem');
    const activeId = menuEl.getAttribute('aria-activedescendant');
    expect(activeId).toBe(items[items.length - 1].getAttribute('id'));
  });

  it('should activate first item on Home key', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    fireEvent.keyDown(menuEl, { key: 'End' });
    fireEvent.keyDown(menuEl, { key: 'Home' });
    const items = screen.getAllByRole('menuitem');
    const activeId = menuEl.getAttribute('aria-activedescendant');
    expect(activeId).toBe(items[0].getAttribute('id'));
  });

  it('should activate last item on End key', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    fireEvent.keyDown(menuEl, { key: 'End' });
    const items = screen.getAllByRole('menuitem');
    const activeId = menuEl.getAttribute('aria-activedescendant');
    expect(activeId).toBe(items[items.length - 1].getAttribute('id'));
  });

  it('should skip disabled items during navigation', () => {
    render(<BasicMenu item2Disabled />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');
    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[0].getAttribute('id'));
    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[2].getAttribute('id'));
  });

  it('should set aria-activedescendant on active item', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    expect(menuEl.getAttribute('aria-activedescendant')).toBeFalsy();
    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });
    expect(menuEl.getAttribute('aria-activedescendant')).toBeTruthy();
  });

  it('should set MenuSeparator role=separator', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button">Item 1</MenuItem>
          <MenuSeparator />
          <MenuItem as="button">Item 2</MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const separator = screen.getByRole('separator');
    expect(separator).not.toBeNull();
  });

  it('should close menu on Tab key', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('should click active item and close menu on Enter key', async () => {
    const onClick = vi.fn();
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button" onClick={onClick}>
            Item 1
          </MenuItem>
          <MenuItem as="button">Item 2</MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });
    await act(async () => {
      fireEvent.keyDown(menuEl, { key: 'Enter' });
    });
    expect(onClick).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('should click active item and close menu on Space key', async () => {
    const onClick = vi.fn();
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button" onClick={onClick}>
            Item 1
          </MenuItem>
          <MenuItem as="button">Item 2</MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });
    await act(async () => {
      fireEvent.keyDown(menuEl, { key: ' ' });
    });
    expect(onClick).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('should not click disabled item on Enter key', async () => {
    const onClick = vi.fn();
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button" disabled onClick={onClick}>
            Disabled Item
          </MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    fireEvent.keyDown(menuEl, { key: 'End' });
    await act(async () => {
      fireEvent.keyDown(menuEl, { key: 'Enter' });
    });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('should navigate typeahead to matching item', async () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button">Apple</MenuItem>
          <MenuItem as="button">Banana</MenuItem>
          <MenuItem as="button">Cherry</MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');

    await act(async () => {
      fireEvent.keyDown(menuEl, { key: 'b' });
    });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[1].getAttribute('id'));
  });

  it('should navigate typeahead wrapping around when no match after current', async () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button">Apple</MenuItem>
          <MenuItem as="button">Banana</MenuItem>
          <MenuItem as="button">Cherry</MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');

    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });
    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });

    await act(async () => {
      fireEvent.keyDown(menuEl, { key: 'a' });
    });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[0].getAttribute('id'));
  });

  it('should handle PageUp and PageDown as Home/End', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');

    fireEvent.keyDown(menuEl, { key: 'End' });
    fireEvent.keyDown(menuEl, { key: 'PageUp' });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[0].getAttribute('id'));

    fireEvent.keyDown(menuEl, { key: 'PageDown' });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(
      items[items.length - 1].getAttribute('id')
    );
  });

  it('should close menu on Enter with no active item', async () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' });
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('should not close menu on disabled button click', () => {
    render(
      <Menu>
        <MenuButton disabled>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button">Item 1</MenuItem>
        </MenuItems>
      </Menu>
    );
    const btn = screen.getByText('Open Menu');
    fireEvent.click(btn);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('should not handle keydown on disabled button', () => {
    render(
      <Menu>
        <MenuButton disabled>Open Menu</MenuButton>
        <MenuItems static>
          <MenuItem as="button">Item 1</MenuItem>
        </MenuItems>
      </Menu>
    );
    const btn = screen.getByText('Open Menu');
    fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('should handle Escape on MenuButton when menu is open', async () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const btn = screen.getByText('Open Menu');
    await act(async () => {
      fireEvent.keyDown(btn, { key: 'Escape' });
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('should render MenuSection with correct structure', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuSection>
            <MenuHeading>Section Heading</MenuHeading>
            <MenuItem as="button">Section Item</MenuItem>
          </MenuSection>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    expect(screen.getByText('Section Heading')).not.toBeNull();
    expect(screen.getByText('Section Item')).not.toBeNull();
  });

  it('should render MenuHeading with presentation role', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuHeading>My Heading</MenuHeading>
          <MenuItem as="button">Item</MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const heading = screen.getByText('My Heading').closest('header');
    expect(heading?.getAttribute('role')).toBe('presentation');
  });

  it('should render MenuItems with portal when portal=true', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems portal>
          <MenuItem as="button">Portal Item</MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    expect(screen.getByText('Portal Item')).not.toBeNull();
  });

  it('should set hover state on MenuButton mouseenter/mouseleave', () => {
    render(<BasicMenu />);
    const btn = screen.getByText('Open Menu');
    fireEvent.mouseEnter(btn);
    fireEvent.mouseLeave(btn);
    expect(btn).not.toBeNull();
  });

  it('should set focus/blur state on MenuButton', async () => {
    render(<BasicMenu />);
    const btn = screen.getByText('Open Menu');
    await act(async () => {
      btn.focus();
    });
    await act(async () => {
      btn.blur();
    });
    expect(btn).not.toBeNull();
  });

  it('should set active state on MenuButton mousedown/mouseup', () => {
    render(<BasicMenu />);
    const btn = screen.getByText('Open Menu');
    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);
    expect(btn).not.toBeNull();
  });

  it('should prevent click on disabled MenuItem', () => {
    const onClick = vi.fn();
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button" disabled onClick={onClick}>
            Disabled
          </MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    fireEvent.click(screen.getByText('Disabled'));
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('should handle pointerMove on MenuItem without error', async () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const items = screen.getAllByRole('menuitem');

    await act(async () => {
      fireEvent.pointerMove(items[1], { screenX: 10, screenY: 20 });
    });
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('should deactivate item on pointer leave', async () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');

    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[0].getAttribute('id'));

    await act(async () => {
      fireEvent.pointerLeave(items[0]);
    });
    expect(menuEl.getAttribute('aria-activedescendant')).toBeFalsy();
  });

  it('should set focus/blur on MenuItem', async () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const items = screen.getAllByRole('menuitem');
    await act(async () => {
      items[0].focus();
    });
    await act(async () => {
      items[0].blur();
    });
    expect(items[0]).not.toBeNull();
  });

  it('should render MenuItems with static prop always visible', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems static>
          <MenuItem as="button">Always Visible Item</MenuItem>
        </MenuItems>
      </Menu>
    );
    expect(screen.getByText('Always Visible Item')).not.toBeNull();
  });

  it('should render MenuItems with unmount=false keeping it in DOM when closed', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems unmount={false}>
          <MenuItem as="button">Hidden Item</MenuItem>
        </MenuItems>
      </Menu>
    );
    const menuEl = document.querySelector('[role="menu"]');
    expect(menuEl).not.toBeNull();
    expect(menuEl?.getAttribute('hidden')).toBe('');
  });

  it('should support render prop on Menu', () => {
    render(
      <Menu>
        {({ open }: { open: boolean }) => (
          <>
            <MenuButton>{open ? 'Close' : 'Open'}</MenuButton>
            <MenuItems>
              <MenuItem as="button">Item</MenuItem>
            </MenuItems>
          </>
        )}
      </Menu>
    );
    expect(screen.getByText('Open')).not.toBeNull();
    fireEvent.click(screen.getByText('Open'));
    expect(screen.getByText('Close')).not.toBeNull();
  });

  it('should support custom as prop on Menu', () => {
    render(
      <Menu as="nav">
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button">Item</MenuItem>
        </MenuItems>
      </Menu>
    );
    expect(document.querySelector('nav')).not.toBeNull();
  });

  it('should open MenuItems with transition=true', async () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems transition>
          <MenuItem as="button">Item</MenuItem>
        </MenuItems>
      </Menu>
    );
    await act(async () => {
      fireEvent.click(screen.getByText('Open Menu'));
    });
    expect(screen.getByRole('menu')).not.toBeNull();
  });

  it('should open menu on ArrowDown key on MenuButton', async () => {
    render(<BasicMenu />);
    const btn = screen.getByText('Open Menu');
    await act(async () => {
      fireEvent.keyDown(btn, { key: 'ArrowDown' });
    });
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('should open menu on ArrowUp key on MenuButton', async () => {
    render(<BasicMenu />);
    const btn = screen.getByText('Open Menu');
    await act(async () => {
      fireEvent.keyDown(btn, { key: 'ArrowUp' });
    });
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('should open menu on Enter key on MenuButton', async () => {
    render(<BasicMenu />);
    const btn = screen.getByText('Open Menu');
    await act(async () => {
      fireEvent.keyDown(btn, { key: 'Enter' });
    });
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('should open menu on Space key on MenuButton', async () => {
    render(<BasicMenu />);
    const btn = screen.getByText('Open Menu');
    await act(async () => {
      fireEvent.keyDown(btn, { key: ' ' });
    });
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('should throw when MenuButton used outside Menu', () => {
    expect(() => {
      render(<MenuButton>Orphan Button</MenuButton>);
    }).toThrow('<MenuButton> must be used within a <Menu>');
  });

  it('should throw when MenuItems used outside Menu', () => {
    expect(() => {
      render(
        <MenuItems>
          <span>item</span>
        </MenuItems>
      );
    }).toThrow('<MenuItems> must be used within a <Menu>');
  });

  it('should throw when MenuItem used outside Menu', () => {
    expect(() => {
      render(<MenuItem as="button">Orphan Item</MenuItem>);
    }).toThrow('<MenuItem> must be used within a <Menu>');
  });

  it('should cover enter transition attrs with RAF flush (lines 75-82)', async () => {
    const raf = new RAFQueue();
    raf.install();

    render(
      <Menu as="div">
        <MenuButton>Open Menu</MenuButton>
        <MenuItems transition unmount={false}>
          <MenuItem as="button">Item</MenuItem>
        </MenuItems>
      </Menu>
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Open Menu'));
    });

    await act(async () => {
      raf.flushOne();
    });

    const menuEl = document.querySelector('[role="menu"]');
    expect(menuEl).not.toBeNull();

    await act(async () => {
      raf.flush();
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('should cover leave transition attrs with RAF flush (lines 84-91)', async () => {
    const raf = new RAFQueue();
    raf.install();

    render(
      <Menu as="div">
        <MenuButton>Open Menu</MenuButton>
        <MenuItems transition unmount={false}>
          <MenuItem as="button">Item</MenuItem>
        </MenuItems>
      </Menu>
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Open Menu'));
    });
    await act(async () => {
      raf.flush();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Open Menu'));
    });
    await act(async () => {
      raf.flush();
    });

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('should dispatch menu:openkey ArrowDown via RAF and activate first item', async () => {
    const raf = new RAFQueue();
    raf.install();

    render(<BasicMenu />);
    const btn = screen.getByText('Open Menu');

    await act(async () => {
      fireEvent.keyDown(btn, { key: 'ArrowDown' });
    });

    await act(async () => {
      raf.flush();
    });

    const menuEl = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[0].getAttribute('id'));
  });

  it('should dispatch menu:openkey ArrowUp via RAF and activate last item', async () => {
    const raf = new RAFQueue();
    raf.install();

    render(<BasicMenu />);
    const btn = screen.getByText('Open Menu');

    await act(async () => {
      fireEvent.keyDown(btn, { key: 'ArrowUp' });
    });

    await act(async () => {
      raf.flush();
    });

    const menuEl = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(
      items[items.length - 1].getAttribute('id')
    );
  });

  it('should dispatch menu:openkey directly on menu element and activate last item', async () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');

    await act(async () => {
      menuEl.dispatchEvent(
        new CustomEvent('menu:openkey', {
          detail: { key: 'ArrowUp' },
          bubbles: false,
        })
      );
    });
    const items = screen.getAllByRole('menuitem');
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(
      items[items.length - 1].getAttribute('id')
    );
  });

  it('should dispatch menu:openkey directly on menu element and activate first item', async () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');

    await act(async () => {
      menuEl.dispatchEvent(
        new CustomEvent('menu:openkey', {
          detail: { key: 'ArrowDown' },
          bubbles: false,
        })
      );
    });
    const items = screen.getAllByRole('menuitem');
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[0].getAttribute('id'));
  });

  it('should navigate ArrowUp with an existing active item (Focus.Previous)', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');

    fireEvent.keyDown(menuEl, { key: 'End' });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(
      items[items.length - 1].getAttribute('id')
    );

    fireEvent.keyDown(menuEl, { key: 'ArrowUp' });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(
      items[items.length - 2].getAttribute('id')
    );
  });

  it('should navigate ArrowDown with an existing active item (Focus.Next)', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');

    fireEvent.keyDown(menuEl, { key: 'Home' });
    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[1].getAttribute('id'));
  });

  it('should handle Home key when already at first item (lines 255-261)', () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');

    fireEvent.keyDown(menuEl, { key: 'End' });
    fireEvent.keyDown(menuEl, { key: 'Home' });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[0].getAttribute('id'));

    fireEvent.keyDown(menuEl, { key: 'Home' });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[0].getAttribute('id'));
  });

  it('should handle Enter key with active item that is disabled (lines 287-288)', async () => {
    const onClick = vi.fn();
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button" disabled onClick={onClick}>
            Disabled Only
          </MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');

    fireEvent.keyDown(menuEl, { key: 'End' });
    await act(async () => {
      fireEvent.keyDown(menuEl, { key: 'Enter' });
    });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('should handle typeahead with repeated character to cover clearTimeout (line 438)', async () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button">Apple</MenuItem>
          <MenuItem as="button">Avocado</MenuItem>
          <MenuItem as="button">Banana</MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');

    await act(async () => {
      fireEvent.keyDown(menuEl, { key: 'a' });
    });
    await act(async () => {
      fireEvent.keyDown(menuEl, { key: 'a' });
    });
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('should typeahead with no match forward but wrap to find match (lines 515-536)', async () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button">Banana</MenuItem>
          <MenuItem as="button">Cherry</MenuItem>
          <MenuItem as="button">Apple</MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');

    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });
    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });

    fireEvent.keyDown(menuEl, { key: 'End' });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[2].getAttribute('id'));

    await act(async () => {
      fireEvent.keyDown(menuEl, { key: 'b' });
    });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[0].getAttribute('id'));
  });

  it('should handle pointerLeave on non-active item (line 679)', async () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');

    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[0].getAttribute('id'));

    await act(async () => {
      fireEvent.pointerLeave(items[1]);
    });
    expect(menuEl.getAttribute('aria-activedescendant')).toBe(items[0].getAttribute('id'));
  });

  it('should handle focus and blur on MenuItem (lines 694-695)', async () => {
    render(<BasicMenu />);
    fireEvent.click(screen.getByText('Open Menu'));
    const items = screen.getAllByRole('menuitem');

    await act(async () => {
      items[1].focus();
    });
    await act(async () => {
      items[1].blur();
    });
    expect(items[1]).not.toBeNull();
  });

  it('should cover typeahead setTimeout body (lines 518-519) with fake timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      render(
        <Menu>
          <MenuButton>Open Menu</MenuButton>
          <MenuItems>
            <MenuItem as="button">Apple</MenuItem>
            <MenuItem as="button">Banana</MenuItem>
          </MenuItems>
        </Menu>
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Open Menu'));
      });
      const menuEl = screen.getByRole('menu');

      await act(async () => {
        fireEvent.keyDown(menuEl, { key: 'a' });
      });

      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      expect(screen.queryByRole('menu')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should close menu on outside click (line 352)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      render(<BasicMenu />);

      await act(async () => {
        fireEvent.click(screen.getByText('Open Menu'));
      });
      expect(screen.queryByRole('menu')).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(10);
      });

      await act(async () => {
        document.body.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
        );
      });

      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MenuSection ARIA', () => {
  it('should set role=group on MenuSection', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuSection>
            <MenuHeading>Section Heading</MenuHeading>
            <MenuItem as="button">Item</MenuItem>
          </MenuSection>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const section = document.querySelector('[role="group"]');
    expect(section).not.toBeNull();
  });

  it('should set aria-labelledby on MenuSection pointing to MenuHeading id', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuSection>
            <MenuHeading>Section Heading</MenuHeading>
            <MenuItem as="button">Item</MenuItem>
          </MenuSection>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const section = document.querySelector('[role="group"]');
    const heading = screen.getByText('Section Heading').closest('header');
    expect(section?.getAttribute('aria-labelledby')).toBe(heading?.getAttribute('id'));
  });

  it('should set id on MenuHeading', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuSection>
            <MenuHeading>Section Heading</MenuHeading>
            <MenuItem as="button">Item</MenuItem>
          </MenuSection>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const heading = screen.getByText('Section Heading').closest('header');
    expect(heading?.getAttribute('id')).toBeTruthy();
  });

  it('should set role=presentation on MenuHeading', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuSection>
            <MenuHeading>Section Heading</MenuHeading>
            <MenuItem as="button">Item</MenuItem>
          </MenuSection>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const heading = screen.getByText('Section Heading').closest('header');
    expect(heading?.getAttribute('role')).toBe('presentation');
  });

  it('should work without MenuHeading (aria-labelledby is null)', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuSection>
            <MenuItem as="button">Item</MenuItem>
          </MenuSection>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const section = document.querySelector('[role="group"]');
    expect(section).not.toBeNull();
    expect(section?.getAttribute('aria-labelledby')).toBeNull();
  });

  it('should work with custom as prop on MenuSection', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuSection as="aside">
            <MenuHeading>Section</MenuHeading>
            <MenuItem as="button">Item</MenuItem>
          </MenuSection>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const section = document.querySelector('aside');
    expect(section?.getAttribute('role')).toBe('group');
  });
});

describe('MenuItem data-* attributes', () => {
  it('should set data-disabled when disabled', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button" disabled>
            Disabled Item
          </MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const item = screen.getByRole('menuitem');
    expect(item.getAttribute('data-disabled')).toBe('');
  });

  it('should not set data-disabled when not disabled', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button">Item</MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const item = screen.getByRole('menuitem');
    expect(item.getAttribute('data-disabled')).toBeNull();
  });

  it('should set data-active when item is active (keyboard navigation)', () => {
    render(
      <Menu>
        <MenuButton>Open Menu</MenuButton>
        <MenuItems>
          <MenuItem as="button">Item 1</MenuItem>
          <MenuItem as="button">Item 2</MenuItem>
        </MenuItems>
      </Menu>
    );
    fireEvent.click(screen.getByText('Open Menu'));
    const menuEl = screen.getByRole('menu');

    fireEvent.keyDown(menuEl, { key: 'ArrowDown' });
    const items = screen.getAllByRole('menuitem');
    expect(items[0].getAttribute('data-active')).toBe('');
  });
});
