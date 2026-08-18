import type { RefObject } from 'preact';
import { createContext, createElement, Fragment } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import {
  ActivationTrigger,
  calculateActiveIndex,
  Focus,
} from '../../internal/calculate-active-index.ts';
import { disposables } from '../../internal/disposables.ts';
import {
  FloatingProvider,
  useFloatingPanel,
  useFloatingPanelProps,
  useFloatingReference,
  useFloatingReferenceProps,
} from '../../internal/floating-provider.tsx';
import { OpenClosedContext, State } from '../../internal/open-closed.ts';
import { Portal } from '../../internal/portal.ts';
import { render } from '../../internal/render.ts';
import { stackMachines } from '../../internal/stack-machine.ts';
import type { ElementType } from '../../internal/types.ts';
import { Features } from '../../internal/types.ts';
import { useEscape } from '../../internal/use-escape.ts';
import { useEvent } from '../../internal/use-event.ts';
import { useId } from '../../internal/use-id.ts';
import { useInert } from '../../internal/use-inert.ts';
import { useIsoMorphicEffect } from '../../internal/use-iso-morphic-effect.ts';
import { useOutsideClick } from '../../internal/use-outside-click.ts';
import {
  useResolvedAnchor,
  type AnchorPropsWithSelection,
} from '../../internal/use-anchor-props.ts';
import { useResolveButtonType } from '../../internal/use-resolve-button-type.ts';
import { useScrollLock } from '../../internal/use-scroll-lock.ts';
import { useSyncRefs } from '../../internal/use-sync-refs.ts';
import { useTextValue } from '../../internal/use-text-value.ts';
import { useTrackedPointer } from '../../internal/use-tracked-pointer.ts';

interface MenuItemData {
  id: string;
  ref: RefObject<HTMLElement | null>;
  readonly disabled: boolean;
  textValue: () => string;
}

interface MenuState {
  id: string;
  open: boolean;
  toggle: () => void;
  close: () => void;
  buttonRef: RefObject<HTMLElement | null>;
  itemsRef: RefObject<HTMLElement | null>;
  buttonId: string;
  itemsId: string;
  items: MenuItemData[];
  registerItem: (item: MenuItemData) => void;
  unregisterItem: (id: string) => void;
  activeItemIndex: number | null;
  setActiveItemIndex: (index: number | null | ((prev: number | null) => number | null)) => void;
  activationTrigger: ActivationTrigger;
  setActivationTrigger: (trigger: ActivationTrigger) => void;
}

const MenuContext = createContext<MenuState | null>(null);
MenuContext.displayName = 'MenuContext';

function useMenuContext(component: string): MenuState {
  const ctx = useContext(MenuContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used within a <Menu>`);
  }
  return ctx;
}

function useTransitionAttrs(open: boolean, transition: boolean) {
  const [transitionAttrs, setTransitionAttrs] = useState<Record<string, ''>>({});
  const prevOpenRef = useRef(open);

  useEffect(() => {
    if (!transition) {
      setTransitionAttrs({});
      return;
    }

    const prev = prevOpenRef.current;
    prevOpenRef.current = open;

    if (open && !prev) {
      setTransitionAttrs({ 'data-transition': '', 'data-enter': '' });
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTransitionAttrs({});
        });
      });
      return () => cancelAnimationFrame(raf);
    }

    if (!open && prev) {
      setTransitionAttrs({ 'data-transition': '', 'data-leave': '', 'data-closed': '' });
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTransitionAttrs({ 'data-closed': '' });
        });
      });
      return () => cancelAnimationFrame(raf);
    }

    if (!open) {
      setTransitionAttrs({ 'data-closed': '' });
    }
  }, [open, transition]);

  return transitionAttrs;
}

interface MenuProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function MenuFn({ as: Tag = Fragment, children, ...rest }: MenuProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MenuItemData[]>([]);
  const [activeItemIndex, setActiveItemIndex] = useState<number | null>(null);
  const [activationTrigger, setActivationTrigger] = useState<ActivationTrigger>(
    ActivationTrigger.Other
  );

  const buttonId = useId();
  const itemsId = useId();
  const buttonRef = useRef<HTMLElement | null>(null);
  const itemsRef = useRef<HTMLElement | null>(null);

  const stackMachine = stackMachines.get(null);

  const isTopLayerRef = useRef(true);
  useIsoMorphicEffect(() => {
    isTopLayerRef.current = stackMachine.selectors.isTop(stackMachine.state, id);
  });

  useIsoMorphicEffect(() => {
    if (open) {
      stackMachine.actions.push(id);
      return () => stackMachine.actions.pop(id);
    }
  }, [open, id, stackMachine]);

  const toggle = useEvent(() => setOpen((v) => !v));

  const close = useEvent(() => {
    setOpen(false);
    setActiveItemIndex(null);
  });

  const registerItem = useEvent((item: MenuItemData) => {
    setItems((prev) => {
      if (item.ref.current && itemsRef.current) {
        const allItems = Array.from(
          itemsRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]')
        );
        const index = allItems.indexOf(item.ref.current);
        if (index !== -1) {
          const next = [...prev];
          next.splice(index, 0, item);
          return next;
        }
      }
      return [...prev, item];
    });
  });

  const unregisterItem = useEvent((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  });

  const ctx: MenuState = {
    id,
    open,
    toggle,
    close,
    buttonRef,
    itemsRef,
    buttonId,
    itemsId,
    items,
    registerItem,
    unregisterItem,
    activeItemIndex,
    setActiveItemIndex,
    activationTrigger,
    setActivationTrigger,
  };

  const slot = { open, close };

  const menuRef = useSyncRefs(
    rest.ref as RefObject<HTMLElement | null> | ((instance: HTMLElement) => void) | null
  );

  return createElement(
    FloatingProvider,
    null,
    createElement(
      MenuContext.Provider,
      { value: ctx },
      createElement(
        OpenClosedContext.Provider,
        { value: open ? State.Open : State.Closed },
        render({
          ourProps: menuRef ? { ref: menuRef } : {},
          theirProps: { as: Tag, children, ...rest },
          slot,
          defaultTag: Fragment,
          name: 'Menu',
        })
      )
    )
  );
}

MenuFn.displayName = 'Menu';
export const Menu = MenuFn;

interface MenuButtonProps {
  as?: ElementType;
  disabled?: boolean;
  autoFocus?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function MenuButtonFn({
  as: Tag = 'button',
  disabled = false,
  autoFocus = false,
  children,
  ...rest
}: MenuButtonProps) {
  const {
    open,
    toggle,
    close,
    buttonRef: contextButtonRef,
    buttonId,
    itemsId,
    itemsRef,
  } = useMenuContext('MenuButton');

  const internalRef = useRef<HTMLElement | null>(null);

  const setFloatingReference = useFloatingReference();
  const getFloatingReferenceProps = useFloatingReferenceProps();

  const buttonRef = useSyncRefs(
    contextButtonRef,
    setFloatingReference,
    internalRef,
    rest.ref as RefObject<HTMLElement | null> | ((instance: HTMLElement) => void) | null
  );

  const resolvedType = useResolveButtonType(
    { as: Tag, type: rest.type as string | undefined },
    internalRef.current
  );

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(false);

  const handleClick = useEvent((e: MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    toggle();
  });

  const handleKeyDown = useEvent((e: KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) {
        toggle();
      }
      requestAnimationFrame(() => {
        const el = itemsRef.current;
        if (el) {
          el.focus();
        }
        el?.dispatchEvent(
          new CustomEvent('menu:openkey', {
            detail: { key: e.key === 'ArrowUp' ? 'ArrowUp' : 'ArrowDown' },
            bubbles: false,
          })
        );
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        toggle();
      }
      requestAnimationFrame(() => {
        const el = itemsRef.current;
        if (el) {
          el.focus();
          el.dispatchEvent(
            new CustomEvent('menu:openkey', {
              detail: { key: 'ArrowUp' },
              bubbles: false,
            })
          );
        }
      });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      requestAnimationFrame(() => {
        contextButtonRef.current?.focus();
      });
    }
  });

  const handleKeyUp = useEvent((e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
    }
  });

  const floatingProps = getFloatingReferenceProps();

  const ourProps: Record<string, unknown> = {
    ...floatingProps,
    id: buttonId,
    ref: buttonRef,
    type: resolvedType,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': itemsId,
    autoFocus,
    disabled: disabled || undefined,
    onClick: handleClick,
    onKeyDown: handleKeyDown,
    onKeyUp: handleKeyUp,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    onMouseDown: () => setActive(true),
    onMouseUp: () => setActive(false),
  };

  const slot = { open, hover, focus, active: active || open, autofocus: autoFocus, disabled };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'button',
    name: 'MenuButton',
  });
}

MenuButtonFn.displayName = 'MenuButton';
export const MenuButton = MenuButtonFn;

interface MenuItemsProps {
  as?: ElementType;
  transition?: boolean;
  static?: boolean;
  unmount?: boolean;
  anchor?: AnchorPropsWithSelection;
  portal?: boolean;
  modal?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function MenuItemsFn({
  as: Tag = 'div',
  transition = false,
  static: isStatic = false,
  unmount = true,
  anchor: rawAnchor,
  portal = false,
  modal = true,
  children,
  ...rest
}: MenuItemsProps) {
  const {
    id: menuId,
    open,
    close,
    buttonRef,
    itemsRef: contextItemsRef,
    buttonId,
    itemsId,
    items,
    activeItemIndex,
    setActiveItemIndex,
    setActivationTrigger,
  } = useMenuContext('MenuItems');

  const anchor = useResolvedAnchor(rawAnchor);

  const internalRef = useRef<HTMLElement | null>(null);

  const [floatingRef, floatingStyles] = useFloatingPanel(anchor);
  const getFloatingPanelProps = useFloatingPanelProps();

  const itemsRef = useSyncRefs(
    contextItemsRef,
    anchor ? floatingRef : null,
    internalRef,
    rest.ref as RefObject<HTMLElement | null> | ((instance: HTMLElement) => void) | null
  );

  const stackMachine = stackMachines.get(null);
  const isTopLayerRef = useRef(true);
  useIsoMorphicEffect(() => {
    isTopLayerRef.current = stackMachine.selectors.isTop(stackMachine.state, menuId);
  });

  const shouldHandleEvents =
    open && (isTopLayerRef.current || !stackMachine.selectors.inStack(stackMachine.state, menuId));

  const searchBufferRef = useRef('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useOutsideClick(
    shouldHandleEvents ? [buttonRef, internalRef] : [],
    useCallback(() => {
      if (shouldHandleEvents) {
        close();
      }
    }, [close, shouldHandleEvents]),
    open
  );

  useEscape(
    useCallback(
      (e: KeyboardEvent) => {
        if (!shouldHandleEvents) return;
        e.preventDefault();
        close();
        requestAnimationFrame(() => {
          buttonRef.current?.focus();
        });
      },
      [close, buttonRef, shouldHandleEvents]
    ),
    open && shouldHandleEvents
  );

  useScrollLock(modal && open && shouldHandleEvents);

  useInert(internalRef, modal && open && shouldHandleEvents);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        internalRef.current?.focus();
      });
    } else {
      setActiveItemIndex(null);
    }
  }, [open, setActiveItemIndex]);

  useEffect(() => {
    const el = internalRef.current;
    if (!el) return;

    function handleOpenKey(e: Event) {
      const key = (e as CustomEvent<{ key: string }>).detail.key;
      if (key === 'ArrowUp') {
        setActiveItemIndex(
          calculateActiveIndex(
            { focus: Focus.Last },
            {
              resolveItems: () =>
                items.map((item) => ({
                  id: item.id,
                  dataRef: { current: { disabled: item.disabled } },
                })),
              resolveActiveIndex: () => null,
              resolveId: (item) => item.id,
              resolveDisabled: (item) => item.dataRef.current.disabled,
            }
          )
        );
      } else {
        setActiveItemIndex(
          calculateActiveIndex(
            { focus: Focus.First },
            {
              resolveItems: () =>
                items.map((item) => ({
                  id: item.id,
                  dataRef: { current: { disabled: item.disabled } },
                })),
              resolveActiveIndex: () => null,
              resolveId: (item) => item.id,
              resolveDisabled: (item) => item.dataRef.current.disabled,
            }
          )
        );
      }
      setActivationTrigger(ActivationTrigger.Other);
    }

    el.addEventListener('menu:openkey', handleOpenKey);
    return () => el.removeEventListener('menu:openkey', handleOpenKey);
  }, [items, setActiveItemIndex, setActivationTrigger]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const resolveItems = () =>
        items.map((item) => ({
          id: item.id,
          dataRef: { current: { disabled: item.disabled } },
        }));
      const resolveActiveIndex = () => activeItemIndex;
      const resolveId = (item: { id: string }) => item.id;
      const resolveDisabled = (item: { dataRef: { current: { disabled: boolean } } }) =>
        item.dataRef.current.disabled;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          setActiveItemIndex(
            calculateActiveIndex(
              { focus: activeItemIndex === null ? Focus.First : Focus.Next },
              { resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
            )
          );
          setActivationTrigger(ActivationTrigger.Other);
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          setActiveItemIndex(
            calculateActiveIndex(
              { focus: activeItemIndex === null ? Focus.Last : Focus.Previous },
              { resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
            )
          );
          setActivationTrigger(ActivationTrigger.Other);
          break;
        }
        case 'Home':
        case 'PageUp': {
          e.preventDefault();
          setActiveItemIndex(
            calculateActiveIndex(
              { focus: Focus.First },
              { resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
            )
          );
          setActivationTrigger(ActivationTrigger.Other);
          break;
        }
        case 'End':
        case 'PageDown': {
          e.preventDefault();
          setActiveItemIndex(
            calculateActiveIndex(
              { focus: Focus.Last },
              { resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
            )
          );
          setActivationTrigger(ActivationTrigger.Other);
          break;
        }
        case 'Enter':
        case ' ': {
          e.preventDefault();
          if (activeItemIndex !== null) {
            const item = items[activeItemIndex];
            if (item && !item.disabled) {
              item.ref.current?.click();
            }
          }
          close();
          requestAnimationFrame(() => {
            buttonRef.current?.focus();
          });
          break;
        }
        case 'Tab': {
          e.preventDefault();
          close();
          requestAnimationFrame(() => {
            const focusableElements = document.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            );
            const buttonEl = buttonRef.current;
            if (!buttonEl) return;
            const currentIndex = Array.from(focusableElements).indexOf(buttonEl);
            const nextIndex = e.shiftKey ? currentIndex - 1 : currentIndex + 1;
            const nextEl = focusableElements[nextIndex];
            if (nextEl) {
              nextEl.focus();
            }
          });
          break;
        }
        default: {
          if (e.key.length === 1 && e.key.match(/\S/)) {
            e.preventDefault();
            searchBufferRef.current += e.key.toLowerCase();
            if (searchTimerRef.current !== null) {
              clearTimeout(searchTimerRef.current);
            }
            searchTimerRef.current = setTimeout(() => {
              searchBufferRef.current = '';
              searchTimerRef.current = null;
            }, 350);

            const query = searchBufferRef.current;
            const matchIndex = items.findIndex((item, index) => {
              if (item.disabled) return false;
              if (activeItemIndex !== null && index <= activeItemIndex) return false;
              return item.textValue().startsWith(query);
            });

            if (matchIndex !== -1) {
              setActiveItemIndex(matchIndex);
              setActivationTrigger(ActivationTrigger.Other);
            } else {
              const wrapIndex = items.findIndex((item) => {
                if (item.disabled) return false;
                return item.textValue().startsWith(query);
              });
              if (wrapIndex !== -1) {
                setActiveItemIndex(wrapIndex);
                setActivationTrigger(ActivationTrigger.Other);
              }
            }
          }
          break;
        }
      }
    },
    [items, activeItemIndex, setActiveItemIndex, setActivationTrigger, close, buttonRef]
  );

  const transitionAttrs = useTransitionAttrs(open, transition);

  const activeItemId =
    activeItemIndex !== null && items[activeItemIndex] ? items[activeItemIndex].id : undefined;

  const floatingPanelProps = anchor ? getFloatingPanelProps() : {};

  if (anchor) {
    portal = true;
  }

  const ourProps: Record<string, unknown> = {
    ...floatingPanelProps,
    id: itemsId,
    ref: itemsRef,
    role: 'menu',
    'aria-activedescendant': activeItemId,
    'aria-labelledby': buttonId,
    tabIndex: open ? 0 : undefined,
    onKeyDown: handleKeyDown,
    style: {
      ...(rest.style as Record<string, unknown> | undefined),
      ...floatingStyles,
    },
    ...transitionAttrs,
  };

  const visible = isStatic || open;
  const features = Features.RenderStrategy | Features.Static;

  const slot = { open };

  const inner = render({
    ourProps,
    theirProps: { as: Tag, static: isStatic, unmount, children, ...rest },
    slot,
    defaultTag: 'div',
    features,
    visible,
    name: 'MenuItems',
  });

  if (portal) {
    return createElement(Portal, { enabled: true, children: inner });
  }

  return inner;
}

MenuItemsFn.displayName = 'MenuItems';
export const MenuItems = MenuItemsFn;

interface MenuItemProps {
  as?: ElementType;
  disabled?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function MenuItemFn({ as: Tag = Fragment, disabled = false, children, ...rest }: MenuItemProps) {
  const {
    close,
    items,
    registerItem,
    unregisterItem,
    activeItemIndex,
    setActiveItemIndex,
    setActivationTrigger,
  } = useMenuContext('MenuItem');

  const id = useId();
  const internalRef = useRef<HTMLElement | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const getTextValue = useTextValue(internalRef);
  const pointer = useTrackedPointer();

  const ref = useSyncRefs(
    internalRef,
    rest.ref as RefObject<HTMLElement | null> | ((instance: HTMLElement) => void) | null
  );

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

  const activeItem = activeItemIndex !== null ? items[activeItemIndex] : null;
  const isActive = activeItem ? activeItem.id === id : false;

  const shouldScrollIntoView = isActive;
  const prevIsActiveRef = useRef(false);

  useIsoMorphicEffect(() => {
    if (!shouldScrollIntoView) {
      prevIsActiveRef.current = false;
      return;
    }

    if (prevIsActiveRef.current) return;
    prevIsActiveRef.current = true;

    return disposables().requestAnimationFrame(() => {
      internalRef.current?.scrollIntoView?.({ block: 'nearest' });
    });
  }, [shouldScrollIntoView]);

  useEffect(() => {
    const itemData: MenuItemData = {
      id,
      ref: internalRef,
      get disabled() {
        return disabledRef.current;
      },
      textValue: getTextValue,
    };
    registerItem(itemData);
    return () => unregisterItem(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleClick = useEvent((e: MouseEvent) => {
    if (disabled) {
      e.preventDefault();
      return;
    }
    close();
  });

  const handleFocus = useEvent(() => {
    if (disabled) return;
    setFocus(true);
    setActiveItemIndex((currentIndex) => {
      const idx = items.findIndex((item) => item.id === id);
      if (idx === -1) return currentIndex;
      return idx;
    });
    setActivationTrigger(ActivationTrigger.Other);
  });

  const handleBlur = useEvent(() => {
    setFocus(false);
  });

  const handlePointerMove = useEvent((e: PointerEvent) => {
    pointer.update(e);
    if (!pointer.wasMoved(e)) return;
    if (disabled) return;
    setHover(true);
    setActiveItemIndex((currentIndex) => {
      const idx = items.findIndex((item) => item.id === id);
      if (idx === -1) return currentIndex;
      return idx;
    });
    setActivationTrigger(ActivationTrigger.Pointer);
  });

  const handlePointerLeave = useEvent((e: PointerEvent) => {
    pointer.update(e);
    setHover(false);
    setActiveItemIndex((currentIndex) => {
      const idx = items.findIndex((item) => item.id === id);
      if (idx !== -1 && currentIndex === idx) return null;
      return currentIndex;
    });
  });

  const ourProps: Record<string, unknown> = {
    id,
    ref,
    role: 'menuitem',
    tabIndex: disabled ? undefined : -1,
    'aria-disabled': disabled || undefined,
    onClick: handleClick,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onPointerMove: handlePointerMove,
    onPointerLeave: handlePointerLeave,
  };

  const slot = {
    active: isActive,
    disabled,
    close,
    focus,
    hover,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: Fragment,
    name: 'MenuItem',
  });
}

MenuItemFn.displayName = 'MenuItem';
export const MenuItem = MenuItemFn;

interface MenuSectionContextValue {
  headingId: string | null;
  setHeadingId: (id: string | null) => void;
}

const MenuSectionContext = createContext<MenuSectionContextValue | null>(null);
MenuSectionContext.displayName = 'MenuSectionContext';

function useMenuSectionContext(): MenuSectionContextValue | null {
  return useContext(MenuSectionContext);
}

interface MenuSectionProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function MenuSectionFn({ as: Tag = 'div', children, ...rest }: MenuSectionProps) {
  const [headingId, setHeadingId] = useState<string | null>(null);
  const stableSetHeadingId = useCallback((id: string | null) => setHeadingId(id), []);

  const ctx: MenuSectionContextValue = {
    headingId,
    setHeadingId: stableSetHeadingId,
  };

  const slot = {};

  const ourProps: Record<string, unknown> = {
    role: 'group',
    'aria-labelledby': headingId,
  };

  return createElement(
    MenuSectionContext.Provider,
    { value: ctx },
    render({
      ourProps,
      theirProps: { as: Tag, children, ...rest },
      slot,
      defaultTag: 'div',
      name: 'MenuSection',
    })
  );
}

MenuSectionFn.displayName = 'MenuSection';
export const MenuSection = MenuSectionFn;

interface MenuHeadingProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function MenuHeadingFn({ as: Tag = 'header', children, ...rest }: MenuHeadingProps) {
  const sectionCtx = useMenuSectionContext();
  const id = useId();

  useEffect(() => {
    if (!sectionCtx) return;
    sectionCtx.setHeadingId(id);
    return () => {
      sectionCtx.setHeadingId(null);
    };
  }, [id, sectionCtx]);

  const slot = {};

  const ourProps: Record<string, unknown> = {
    id,
    role: 'presentation',
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'header',
    name: 'MenuHeading',
  });
}

MenuHeadingFn.displayName = 'MenuHeading';
export const MenuHeading = MenuHeadingFn;

interface MenuSeparatorProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function MenuSeparatorFn({ as: Tag = 'div', children, ...rest }: MenuSeparatorProps) {
  const slot = {};

  return render({
    ourProps: { role: 'separator' },
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'div',
    name: 'MenuSeparator',
  });
}

MenuSeparatorFn.displayName = 'MenuSeparator';
export const MenuSeparator = MenuSeparatorFn;
