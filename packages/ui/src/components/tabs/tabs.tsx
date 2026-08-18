import { createContext, createElement, type Ref } from 'preact';
import { forwardRef } from 'preact/compat';
import { useCallback, useContext, useState } from 'preact/hooks';
import { focusElement } from '../../internal/focus-management.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { Features } from '../../internal/types.ts';
import { useControllable } from '../../internal/use-controllable.ts';
import { useEvent } from '../../internal/use-event.ts';
import { useId } from '../../internal/use-id.ts';
import { useIsoMorphicEffect } from '../../internal/use-iso-morphic-effect.ts';
import { useResolveButtonType } from '../../internal/use-resolve-button-type.ts';
import { optionalRef, useSyncRefs } from '../../internal/use-sync-refs.ts';

interface TabData {
  id: string;
  ref: { current: HTMLElement | null };
  disabled: boolean;
}

interface PanelData {
  id: string;
  ref: { current: HTMLElement | null };
}

interface TabGroupState {
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  tabs: TabData[];
  panels: PanelData[];
  registerTab: (tab: TabData) => () => void;
  registerPanel: (panel: PanelData) => () => void;
  manual: boolean;
  vertical: boolean;
}

const TabGroupContext = createContext<TabGroupState | null>(null);
TabGroupContext.displayName = 'TabGroupContext';

function useTabGroupContext(component: string): TabGroupState {
  const ctx = useContext(TabGroupContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used within a <TabGroup>`);
  }
  return ctx;
}

function sortByDomOrder<T extends { ref: { current: HTMLElement | null } }>(items: T[]): T[] {
  return items.slice().sort((a, b) => {
    if (!a.ref.current || !b.ref.current) return 0;
    const position = a.ref.current.compareDocumentPosition(b.ref.current);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

interface TabGroupProps {
  as?: ElementType;
  selectedIndex?: number;
  defaultIndex?: number;
  onChange?: (index: number) => void;
  manual?: boolean;
  vertical?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function TabGroupFn(
  {
    as: Tag = 'div',
    selectedIndex: controlledIndex,
    defaultIndex = 0,
    onChange,
    manual = false,
    vertical = false,
    children,
    ...rest
  }: TabGroupProps,
  ref: Ref<HTMLElement>
) {
  const [selectedIndex, setSelectedIndex] = useControllable(
    controlledIndex,
    onChange,
    defaultIndex
  );

  const [tabs, setTabs] = useState<TabData[]>([]);
  const [panels, setPanels] = useState<PanelData[]>([]);

  const registerTab = useEvent((tab: TabData) => {
    setTabs((prev) => {
      if (prev.find((t) => t.id === tab.id)) return prev;
      const next = [...prev, tab];
      return sortByDomOrder(next);
    });
    return () => {
      setTabs((prev) => prev.filter((t) => t.id !== tab.id));
    };
  });

  const registerPanel = useEvent((panel: PanelData) => {
    setPanels((prev) => {
      if (prev.find((p) => p.id === panel.id)) return prev;
      const next = [...prev, panel];
      return sortByDomOrder(next);
    });
    return () => {
      setPanels((prev) => prev.filter((p) => p.id !== panel.id));
    };
  });

  const ctx: TabGroupState = {
    selectedIndex,
    setSelectedIndex,
    tabs,
    panels,
    registerTab,
    registerPanel,
    manual,
    vertical,
  };

  const slot = { selectedIndex };

  const groupRef = useSyncRefs(ref);

  return createElement(
    TabGroupContext.Provider,
    { value: ctx },
    render({
      ourProps: { ref: groupRef },
      theirProps: { as: Tag, children, ...rest },
      slot,
      defaultTag: 'div',
      name: 'TabGroup',
    })
  );
}

TabGroupFn.displayName = 'TabGroup';
export const TabGroup = forwardRef(TabGroupFn);

interface TabListProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function TabListFn({ as: Tag = 'div', children, ...rest }: TabListProps, ref: Ref<HTMLElement>) {
  const { selectedIndex, vertical } = useTabGroupContext('TabList');

  const slot = { selectedIndex };

  const listRef = useSyncRefs(ref);

  const ourProps: Record<string, unknown> = {
    ref: listRef,
    role: 'tablist',
    'aria-orientation': vertical ? 'vertical' : 'horizontal',
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'div',
    name: 'TabList',
  });
}

TabListFn.displayName = 'TabList';
export const TabList = forwardRef(TabListFn);

interface TabProps {
  as?: ElementType;
  disabled?: boolean;
  autoFocus?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function TabFn(
  { as: Tag = 'button', disabled = false, autoFocus = false, children, ...rest }: TabProps,
  ref: Ref<HTMLElement>
) {
  const { selectedIndex, setSelectedIndex, tabs, panels, manual, vertical, registerTab } =
    useTabGroupContext('Tab');

  const id = useId();
  const internalRef = { current: null as HTMLElement | null };
  const [element, setElement] = useState<HTMLElement | null>(null);
  const tabRef = useSyncRefs(
    internalRef,
    ref,
    optionalRef((el: HTMLElement) => setElement(el))
  );

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(false);

  useIsoMorphicEffect(() => {
    const tabData: TabData = { id, ref: internalRef, disabled };
    return registerTab(tabData);
  }, [id, registerTab, disabled]);

  const myIndex = tabs.findIndex((t) => t.id === id);
  const selected = myIndex !== -1 && myIndex === selectedIndex;
  const panelId = panels[myIndex]?.id;

  const buttonType = useResolveButtonType(
    { as: Tag, type: rest.type as string | undefined },
    element
  );

  const getNextNonDisabledIndex = useCallback(
    (from: number, direction: 1 | -1): number => {
      const count = tabs.length;
      for (let i = 1; i <= count; i++) {
        const idx = (from + direction * i + count) % count;
        if (!tabs[idx]?.disabled) return idx;
      }
      return from;
    },
    [tabs]
  );

  const handleKeyDown = useEvent((e: KeyboardEvent) => {
    if (myIndex === -1) return;

    const prevKey = vertical ? 'ArrowUp' : 'ArrowLeft';
    const nextKey = vertical ? 'ArrowDown' : 'ArrowRight';

    let targetIndex: number | null = null;
    const shouldActivateOnNavigate = !manual;

    switch (e.key) {
      case nextKey: {
        e.preventDefault();
        targetIndex = getNextNonDisabledIndex(myIndex, 1);
        break;
      }
      case prevKey: {
        e.preventDefault();
        targetIndex = getNextNonDisabledIndex(myIndex, -1);
        break;
      }
      case 'Home': {
        e.preventDefault();
        targetIndex = getNextNonDisabledIndex(-1, 1);
        break;
      }
      case 'End': {
        e.preventDefault();
        targetIndex = getNextNonDisabledIndex(tabs.length, -1);
        break;
      }
      case 'Enter':
      case ' ': {
        e.preventDefault();
        if (!disabled) {
          setSelectedIndex(myIndex);
        }
        return;
      }
      default:
        return;
    }

    if (targetIndex === null) return;

    const targetTab = tabs[targetIndex];
    if (!targetTab) return;

    focusElement(targetTab.ref.current);
    if (shouldActivateOnNavigate && !targetTab.disabled) {
      setSelectedIndex(targetIndex);
    }
  });

  const handleClick = useEvent((e: MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    if (myIndex !== -1) {
      setSelectedIndex(myIndex);
    }
  });

  const handleFocus = useEvent(() => {
    setFocus(true);
    if (!manual && !disabled && myIndex !== -1) {
      setSelectedIndex(myIndex);
    }
  });

  const handleBlur = useEvent(() => setFocus(false));
  const handleMouseEnter = useEvent(() => setHover(true));
  const handleMouseLeave = useEvent(() => setHover(false));
  const handleMouseDown = useEvent(() => setActive(true));
  const handleMouseUp = useEvent(() => setActive(false));

  const ourProps: Record<string, unknown> = {
    id,
    ref: tabRef,
    role: 'tab',
    type: buttonType,
    'aria-selected': selected,
    'aria-controls': panelId,
    tabIndex: selected ? 0 : -1,
    autoFocus,
    disabled: disabled || undefined,
    onClick: handleClick,
    onKeyDown: handleKeyDown,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onMouseDown: handleMouseDown,
    onMouseUp: handleMouseUp,
  };

  const slot = { selected, hover, focus, active, autofocus: autoFocus, disabled };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'button',
    name: 'Tab',
  });
}

TabFn.displayName = 'Tab';
export const Tab = forwardRef(TabFn);

interface TabPanelsProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function TabPanelsFn(
  { as: Tag = 'div', children, ...rest }: TabPanelsProps,
  ref: Ref<HTMLElement>
) {
  const { selectedIndex } = useTabGroupContext('TabPanels');

  const slot = { selectedIndex };

  const panelsRef = useSyncRefs(ref);

  return render({
    ourProps: { ref: panelsRef },
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'div',
    name: 'TabPanels',
  });
}

TabPanelsFn.displayName = 'TabPanels';
export const TabPanels = forwardRef(TabPanelsFn);

interface TabPanelProps {
  as?: ElementType;
  static?: boolean;
  unmount?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function TabPanelFn(
  { as: Tag = 'div', static: isStatic = false, unmount = true, children, ...rest }: TabPanelProps,
  ref: Ref<HTMLElement>
) {
  const { selectedIndex, panels, tabs, registerPanel } = useTabGroupContext('TabPanel');

  const id = useId();
  const internalRef = { current: null as HTMLElement | null };
  const panelRef = useSyncRefs(internalRef, ref);

  const [focus, setFocus] = useState(false);

  useIsoMorphicEffect(() => {
    const panelData: PanelData = { id, ref: internalRef };
    return registerPanel(panelData);
  }, [id, registerPanel]);

  const myIndex = panels.findIndex((p) => p.id === id);
  const selected = myIndex !== -1 && myIndex === selectedIndex;
  const tabId = tabs[myIndex]?.id;

  const handleFocus = useEvent(() => setFocus(true));
  const handleBlur = useEvent(() => setFocus(false));

  const ourProps: Record<string, unknown> = {
    id,
    ref: panelRef,
    role: 'tabpanel',
    'aria-labelledby': tabId,
    tabIndex: selected ? 0 : undefined,
    onFocus: handleFocus,
    onBlur: handleBlur,
  };

  const slot = { selected, focus };

  const features = Features.RenderStrategy | Features.Static;

  return render({
    ourProps,
    theirProps: {
      as: Tag,
      static: isStatic,
      unmount,
      children,
      ...rest,
    },
    slot,
    defaultTag: 'div',
    features,
    visible: isStatic || selected,
    name: 'TabPanel',
  });
}

TabPanelFn.displayName = 'TabPanel';
export const TabPanel = forwardRef(TabPanelFn);
