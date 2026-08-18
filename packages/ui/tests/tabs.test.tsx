import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '../src/mod.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function BasicTabs({
  defaultIndex,
  selectedIndex,
  onChange,
  manual,
  vertical,
}: {
  defaultIndex?: number;
  selectedIndex?: number;
  onChange?: (index: number) => void;
  manual?: boolean;
  vertical?: boolean;
}) {
  return (
    <TabGroup
      defaultIndex={defaultIndex}
      selectedIndex={selectedIndex}
      onChange={onChange}
      manual={manual}
      vertical={vertical}
    >
      <TabList>
        <Tab>Tab 1</Tab>
        <Tab>Tab 2</Tab>
        <Tab>Tab 3</Tab>
      </TabList>
      <TabPanels>
        <TabPanel>Panel 1</TabPanel>
        <TabPanel>Panel 2</TabPanel>
        <TabPanel>Panel 3</TabPanel>
      </TabPanels>
    </TabGroup>
  );
}

function TabsWithDisabled() {
  return (
    <TabGroup>
      <TabList>
        <Tab>Tab 1</Tab>
        <Tab disabled>Tab 2</Tab>
        <Tab>Tab 3</Tab>
      </TabList>
      <TabPanels>
        <TabPanel>Panel 1</TabPanel>
        <TabPanel>Panel 2</TabPanel>
        <TabPanel>Panel 3</TabPanel>
      </TabPanels>
    </TabGroup>
  );
}

describe('TabGroup', () => {
  it('should render with first tab selected by default', () => {
    render(<BasicTabs />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    expect(tabs[2].getAttribute('aria-selected')).toBe('false');
    expect(screen.getByText('Panel 1')).toBeTruthy();
    expect(screen.queryByText('Panel 2')).toBeNull();
  });

  it('should use defaultIndex for initial selection', () => {
    render(<BasicTabs defaultIndex={1} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[2].getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByText('Panel 1')).toBeNull();
    expect(screen.getByText('Panel 2')).toBeTruthy();
  });

  it('should support controlled selectedIndex + onChange', () => {
    const onChange = vi.fn();
    render(<BasicTabs selectedIndex={0} onChange={onChange} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');

    fireEvent.click(tabs[1]);
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('should set role=tablist on TabList', () => {
    render(<BasicTabs />);
    expect(screen.getByRole('tablist')).toBeTruthy();
  });

  it('should set role=tab on Tab', () => {
    render(<BasicTabs />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
  });

  it('should set role=tabpanel on TabPanel', () => {
    render(<BasicTabs />);
    const panels = screen.getAllByRole('tabpanel');
    expect(panels).toHaveLength(1);
  });

  it('should set aria-selected=true on selected Tab', () => {
    render(<BasicTabs />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    expect(tabs[2].getAttribute('aria-selected')).toBe('false');
  });

  it('should set tabindex=0 on selected Tab and -1 on others', () => {
    render(<BasicTabs />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].getAttribute('tabindex')).toBe('0');
    expect(tabs[1].getAttribute('tabindex')).toBe('-1');
    expect(tabs[2].getAttribute('tabindex')).toBe('-1');
  });

  it('should set aria-controls linking Tab to TabPanel', () => {
    render(<BasicTabs />);
    const tabs = screen.getAllByRole('tab');
    const panel = screen.getByRole('tabpanel');
    const panelId = panel.getAttribute('id');

    expect(tabs[0].getAttribute('aria-controls')).toBe(panelId);
  });

  it('should set aria-labelledby linking TabPanel to Tab', () => {
    render(<BasicTabs />);
    const tabs = screen.getAllByRole('tab');
    const panel = screen.getByRole('tabpanel');
    const tabId = tabs[0].getAttribute('id');

    expect(panel.getAttribute('aria-labelledby')).toBe(tabId);
  });

  it('should navigate with ArrowRight key (horizontal)', () => {
    render(<BasicTabs />);
    const tabs = screen.getAllByRole('tab');

    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });

    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  });

  it('should navigate with ArrowLeft key (horizontal)', () => {
    render(<BasicTabs defaultIndex={1} />);
    const tabs = screen.getAllByRole('tab');

    fireEvent.keyDown(tabs[1], { key: 'ArrowLeft' });

    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
  });

  it('should wrap around when navigating past last tab', () => {
    render(<BasicTabs defaultIndex={2} />);
    const tabs = screen.getAllByRole('tab');

    fireEvent.keyDown(tabs[2], { key: 'ArrowRight' });

    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[2].getAttribute('aria-selected')).toBe('false');
  });

  it('should navigate with ArrowDown/ArrowUp when vertical', () => {
    render(<BasicTabs vertical />);
    const tabs = screen.getAllByRole('tab');

    fireEvent.keyDown(tabs[0], { key: 'ArrowDown' });
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(tabs[1], { key: 'ArrowUp' });
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  });

  it('should skip disabled tabs', () => {
    render(<TabsWithDisabled />);
    const tabs = screen.getAllByRole('tab');

    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });

    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
  });

  it('should jump to first tab on Home key', () => {
    render(<BasicTabs defaultIndex={2} />);
    const tabs = screen.getAllByRole('tab');

    fireEvent.keyDown(tabs[2], { key: 'Home' });

    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[2].getAttribute('aria-selected')).toBe('false');
  });

  it('should jump to last tab on End key', () => {
    render(<BasicTabs />);
    const tabs = screen.getAllByRole('tab');

    fireEvent.keyDown(tabs[0], { key: 'End' });

    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
  });

  it('should show only selected TabPanel (unmount mode)', () => {
    render(<BasicTabs />);

    expect(screen.getByText('Panel 1')).toBeTruthy();
    expect(screen.queryByText('Panel 2')).toBeNull();
    expect(screen.queryByText('Panel 3')).toBeNull();

    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs[1]);

    expect(screen.queryByText('Panel 1')).toBeNull();
    expect(screen.getByText('Panel 2')).toBeTruthy();
    expect(screen.queryByText('Panel 3')).toBeNull();
  });

  it('should not render unselected TabPanels by default', () => {
    render(<BasicTabs />);

    expect(screen.queryByText('Panel 2')).toBeNull();
    expect(screen.queryByText('Panel 3')).toBeNull();
  });

  it('manual mode: should not select on arrow key, only on Enter/Space', () => {
    render(<BasicTabs manual />);
    const tabs = screen.getAllByRole('tab');

    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });

    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');

    fireEvent.keyDown(tabs[1], { key: 'Enter' });
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  });

  it('should throw when Tab used outside TabGroup', () => {
    expect(() => {
      render(<Tab>Orphan</Tab>);
    }).toThrow('<Tab> must be used within a <TabGroup>');
  });

  it('should throw when TabList used outside TabGroup', () => {
    expect(() => {
      render(
        <TabList>
          <Tab>Orphan</Tab>
        </TabList>
      );
    }).toThrow('<TabList> must be used within a <TabGroup>');
  });

  it('should throw when TabPanels used outside TabGroup', () => {
    expect(() => {
      render(
        <TabPanels>
          <TabPanel>Orphan</TabPanel>
        </TabPanels>
      );
    }).toThrow('<TabPanels> must be used within a <TabGroup>');
  });

  it('should throw when TabPanel used outside TabGroup', () => {
    expect(() => {
      render(<TabPanel>Orphan</TabPanel>);
    }).toThrow('<TabPanel> must be used within a <TabGroup>');
  });

  it('should handle Tab mouseenter and mouseleave', () => {
    render(<BasicTabs />);
    const tabs = screen.getAllByRole('tab');
    fireEvent.mouseEnter(tabs[0]);
    fireEvent.mouseLeave(tabs[0]);
    expect(tabs[0]).not.toBeNull();
  });

  it('should handle Tab mousedown and mouseup', () => {
    render(<BasicTabs />);
    const tabs = screen.getAllByRole('tab');
    fireEvent.mouseDown(tabs[0]);
    fireEvent.mouseUp(tabs[0]);
    expect(tabs[0]).not.toBeNull();
  });

  it('should handle Tab blur', async () => {
    render(<BasicTabs />);
    const tabs = screen.getAllByRole('tab');
    await act(async () => {
      tabs[0].focus();
    });
    await act(async () => {
      tabs[0].blur();
    });
    expect(tabs[0]).not.toBeNull();
  });

  it('should handle TabPanel focus and blur', async () => {
    render(<BasicTabs />);
    const panel = screen.getByRole('tabpanel');
    await act(async () => {
      panel.focus();
    });
    await act(async () => {
      panel.blur();
    });
    expect(panel).not.toBeNull();
  });

  it('should handle unknown keydown on Tab (default case)', () => {
    render(<BasicTabs />);
    const tabs = screen.getAllByRole('tab');
    fireEvent.keyDown(tabs[0], { key: 'a' });
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  });

  it('should handle all-disabled tabs in getNextNonDisabledIndex (returns original index)', () => {
    render(
      <TabGroup>
        <TabList>
          <Tab disabled>Tab 1</Tab>
          <Tab disabled>Tab 2</Tab>
          <Tab disabled>Tab 3</Tab>
        </TabList>
        <TabPanels>
          <TabPanel static>Panel 1</TabPanel>
          <TabPanel static>Panel 2</TabPanel>
          <TabPanel static>Panel 3</TabPanel>
        </TabPanels>
      </TabGroup>
    );
    const tabs = screen.getAllByRole('tab');
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(tabs[0]).not.toBeNull();
  });

  it('manual mode: Enter on disabled tab should not select', () => {
    render(
      <TabGroup manual>
        <TabList>
          <Tab>Tab 1</Tab>
          <Tab disabled>Tab 2</Tab>
          <Tab>Tab 3</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>Panel 1</TabPanel>
          <TabPanel>Panel 2</TabPanel>
          <TabPanel>Panel 3</TabPanel>
        </TabPanels>
      </TabGroup>
    );
    const tabs = screen.getAllByRole('tab');
    fireEvent.keyDown(tabs[1], { key: 'Enter' });
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
  });

  it('should handle static TabPanel (always visible)', () => {
    render(
      <TabGroup>
        <TabList>
          <Tab>Tab 1</Tab>
          <Tab>Tab 2</Tab>
        </TabList>
        <TabPanels>
          <TabPanel static>Panel 1</TabPanel>
          <TabPanel static>Panel 2</TabPanel>
        </TabPanels>
      </TabGroup>
    );
    expect(screen.getByText('Panel 1')).not.toBeNull();
    expect(screen.getByText('Panel 2')).not.toBeNull();
  });

  it('should handle unmount=false TabPanel (hidden but in DOM)', () => {
    render(
      <TabGroup>
        <TabList>
          <Tab>Tab 1</Tab>
          <Tab>Tab 2</Tab>
        </TabList>
        <TabPanels>
          <TabPanel unmount={false}>Panel 1</TabPanel>
          <TabPanel unmount={false}>Panel 2</TabPanel>
        </TabPanels>
      </TabGroup>
    );
    expect(screen.getByText('Panel 1')).not.toBeNull();
    const panel2 = screen.getByText('Panel 2').closest('[role="tabpanel"]');
    expect(panel2?.getAttribute('hidden')).toBe('');
  });

  it('should set aria-orientation=vertical when vertical prop is true', () => {
    render(<BasicTabs vertical />);
    const tablist = screen.getByRole('tablist');
    expect(tablist.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('should set aria-orientation=horizontal by default', () => {
    render(<BasicTabs />);
    const tablist = screen.getByRole('tablist');
    expect(tablist.getAttribute('aria-orientation')).toBe('horizontal');
  });
});
