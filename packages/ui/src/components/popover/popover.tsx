import type { RefObject } from 'preact';
import { createContext, createElement, Fragment } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CloseContext } from '../../hooks/use-close.ts';
import {
  FloatingProvider,
  useFloatingPanel,
  useFloatingPanelProps,
  useFloatingReference,
} from '../../internal/floating-provider.tsx';
import { OpenClosedContext, State } from '../../internal/open-closed.ts';
import { Portal } from '../../internal/portal.ts';
import { render } from '../../internal/render.ts';
import { stackMachines } from '../../internal/stack-machine.ts';
import type { ElementType } from '../../internal/types.ts';
import { Features } from '../../internal/types.ts';
import { useEscape } from '../../internal/use-escape.ts';
import { useEvent } from '../../internal/use-event.ts';
import { useFocusTrap } from '../../internal/use-focus-trap.ts';
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
import { optionalRef, useSyncRefs } from '../../internal/use-sync-refs.ts';

interface PopoverState {
  id: string;
  open: boolean;
  toggle: () => void;
  close: (focusRef?: { current: HTMLElement | null }) => void;
  buttonRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  buttonId: string;
  panelId: string;
}

interface PopoverRegisterBag {
  buttonId: RefObject<string | null>;
  panelId: RefObject<string | null>;
  close: () => void;
}

const PopoverContext = createContext<PopoverState | null>(null);
PopoverContext.displayName = 'PopoverContext';

function usePopoverContext(component: string): PopoverState {
  const ctx = useContext(PopoverContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used within a <Popover>`);
  }
  return ctx;
}

const PopoverPanelContext = createContext<string | null>(null);
PopoverPanelContext.displayName = 'PopoverPanelContext';

const PopoverGroupContext = createContext<{
  registerPopover: (registerBag: PopoverRegisterBag) => void;
  unregisterPopover: (registerBag: PopoverRegisterBag) => void;
  isFocusWithinPopoverGroup: () => boolean;
  closeOthers: (buttonId: string) => void;
} | null>(null);
PopoverGroupContext.displayName = 'PopoverGroupContext';

function usePopoverGroupContext() {
  return useContext(PopoverGroupContext);
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

interface PopoverProps {
  as?: ElementType;
  open?: boolean;
  onChange?: (open: boolean) => void;
  children?: unknown;
  [key: string]: unknown;
}

function PopoverFn({
  as: Tag = Fragment,
  open: controlledOpen,
  onChange,
  children,
  ...rest
}: PopoverProps) {
  const id = useId();
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const buttonId = useId();
  const panelId = useId();
  const buttonRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const internalRef = useRef<HTMLElement | null>(null);

  const handleChange = useEvent((newValue: boolean) => {
    if (!isControlled) {
      setInternalOpen(newValue);
    }
    onChange?.(newValue);
  });

  const toggle = useCallback(() => handleChange(!open), [open, handleChange]);

  const close = useCallback(
    (focusRef?: { current: HTMLElement | null }) => {
      handleChange(false);
      const target = focusRef?.current ?? buttonRef.current;
      if (target) {
        requestAnimationFrame(() => {
          target.focus();
        });
      }
    },
    [handleChange]
  );

  const ctx: PopoverState = useMemo(
    () => ({
      id,
      open,
      toggle,
      close,
      buttonRef,
      panelRef,
      buttonId,
      panelId,
    }),
    [id, open, toggle, close, buttonId, panelId]
  );

  const slot = useMemo(() => ({ open, close }), [open, close]);

  const popoverRef = useSyncRefs(
    'ref' in rest ? (rest.ref as import('preact').Ref<HTMLElement>) : null,
    optionalRef((ref) => {
      internalRef.current = ref;
    }, Tag === Fragment)
  );

  const groupContext = usePopoverGroupContext();
  const buttonIdRef = useRef(buttonId);
  const panelIdRef = useRef(panelId);
  buttonIdRef.current = buttonId;
  panelIdRef.current = panelId;

  useEffect(() => {
    if (!groupContext) return;

    const registerBag: PopoverRegisterBag = {
      buttonId: buttonIdRef,
      panelId: panelIdRef,
      close,
    };
    groupContext.registerPopover(registerBag);
    return () => groupContext.unregisterPopover(registerBag);
  }, [groupContext, close]);

  const ourProps = Tag === Fragment ? {} : { ref: popoverRef };

  return createElement(
    FloatingProvider,
    null,
    createElement(
      PopoverPanelContext.Provider,
      { value: null },
      createElement(
        PopoverContext.Provider,
        { value: ctx },
        createElement(
          OpenClosedContext.Provider,
          { value: open ? State.Open : State.Closed },
          createElement(
            CloseContext.Provider,
            { value: close },
            render({
              ourProps,
              theirProps: { as: Tag, children, ...rest },
              slot,
              defaultTag: Fragment,
              name: 'Popover',
            })
          )
        )
      )
    )
  );
}

PopoverFn.displayName = 'Popover';
export const Popover = PopoverFn;

interface PopoverButtonProps {
  as?: ElementType;
  disabled?: boolean;
  autoFocus?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function PopoverButtonFn({
  as: Tag = 'button',
  disabled = false,
  autoFocus = false,
  children,
  ...rest
}: PopoverButtonProps) {
  const { open, toggle, close, buttonRef, buttonId, panelId } = usePopoverContext('PopoverButton');

  const panelContext = useContext(PopoverPanelContext);
  const isWithinPanel = panelContext !== null;

  const groupContext = usePopoverGroupContext();

  const internalRef = useRef<HTMLElement | null>(null);

  const setFloatingReference = useFloatingReference();

  const resolvedType = useResolveButtonType(
    { as: Tag, type: rest.type as string | undefined },
    internalRef.current
  );

  const syncedRef = useSyncRefs(
    internalRef,
    isWithinPanel ? null : buttonRef,
    isWithinPanel ? null : setFloatingReference,
    'ref' in rest ? (rest.ref as import('preact').Ref<HTMLElement>) : null,
    optionalRef((el: HTMLElement) => {
      if (!isWithinPanel) {
        buttonRef.current = el;
      }
    })
  );

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(false);

  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      if (isWithinPanel) {
        close();
        buttonRef.current?.focus();
      } else {
        if (groupContext && !open) {
          groupContext.closeOthers(buttonId);
        }
        toggle();
      }
    },
    [disabled, toggle, close, isWithinPanel, buttonRef, groupContext, open, buttonId]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (disabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isWithinPanel) {
          close();
          buttonRef.current?.focus();
        } else {
          if (groupContext && !open) {
            groupContext.closeOthers(buttonId);
          }
          toggle();
        }
      }
    },
    [disabled, toggle, close, isWithinPanel, buttonRef, groupContext, open, buttonId]
  );

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
    }
  }, []);

  const ourProps: Record<string, unknown> = isWithinPanel
    ? {
        ref: syncedRef,
        type: resolvedType,
        disabled: disabled || undefined,
        autoFocus,
        onClick: handleClick,
        onKeyDown: handleKeyDown,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setFocus(true),
        onBlur: () => setFocus(false),
        onMouseDown: () => setActive(true),
        onMouseUp: () => setActive(false),
      }
    : {
        id: buttonId,
        ref: syncedRef,
        type: resolvedType,
        'aria-expanded': open,
        'aria-controls': open ? panelId : undefined,
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
    name: 'PopoverButton',
  });
}

PopoverButtonFn.displayName = 'PopoverButton';
export const PopoverButton = PopoverButtonFn;

interface PopoverBackdropProps {
  as?: ElementType;
  transition?: boolean;
  static?: boolean;
  unmount?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function PopoverBackdropFn({
  as: Tag = 'div',
  transition = false,
  static: isStatic = false,
  unmount = true,
  children,
  ...rest
}: PopoverBackdropProps) {
  const { open, close } = usePopoverContext('PopoverBackdrop');

  const internalRef = useRef<HTMLElement | null>(null);

  const backdropRef = useSyncRefs(
    internalRef,
    'ref' in rest ? (rest.ref as import('preact').Ref<HTMLElement>) : null
  );

  const handleClick = useEvent((e: MouseEvent) => {
    e.preventDefault();
    close();
  });

  const transitionAttrs = useTransitionAttrs(open, transition);

  const ourProps: Record<string, unknown> = {
    ref: backdropRef,
    'aria-hidden': true,
    onClick: handleClick,
    ...transitionAttrs,
  };

  const visible = isStatic || open;
  const features = Features.RenderStrategy | Features.Static;

  const slot = { open };

  return render({
    ourProps,
    theirProps: { as: Tag, static: isStatic, unmount, children, ...rest },
    slot,
    defaultTag: 'div',
    features,
    visible,
    name: 'PopoverBackdrop',
  });
}

PopoverBackdropFn.displayName = 'PopoverBackdrop';
/** @public */
export const PopoverBackdrop = PopoverBackdropFn;

interface PopoverPanelProps {
  as?: ElementType;
  transition?: boolean;
  static?: boolean;
  unmount?: boolean;
  anchor?: AnchorPropsWithSelection;
  portal?: boolean;
  modal?: boolean;
  focus?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function PopoverPanelFn({
  as: Tag = 'div',
  transition = false,
  static: isStatic = false,
  unmount = true,
  anchor: rawAnchor,
  portal = false,
  modal = false,
  focus: focusContainment = false,
  children,
  ...rest
}: PopoverPanelProps) {
  const { id, open, close, buttonRef, panelRef, panelId, buttonId } =
    usePopoverContext('PopoverPanel');

  const anchor = useResolvedAnchor(rawAnchor);

  const internalRef = useRef<HTMLElement | null>(null);

  const [floatingRef, floatingStyles] = useFloatingPanel(anchor);
  const getFloatingPanelProps = useFloatingPanelProps();

  const syncedRef = useSyncRefs(
    panelRef,
    anchor ? floatingRef : null,
    internalRef,
    'ref' in rest ? (rest.ref as import('preact').Ref<HTMLElement>) : null
  );

  const stackMachine = stackMachines.get(null);

  const isTopLayerRef = useRef(true);

  useIsoMorphicEffect(() => {
    if (open) {
      stackMachine.actions.push(id);
      isTopLayerRef.current = stackMachine.selectors.isTop(stackMachine.state, id);
      return () => {
        stackMachine.actions.pop(id);
      };
    }
  }, [open, id, stackMachine]);

  const shouldHandleEvents =
    open && (isTopLayerRef.current || !stackMachine.selectors.inStack(stackMachine.state, id));

  const trapFocus = modal || focusContainment;

  useFocusTrap(internalRef, open && trapFocus && shouldHandleEvents, { restoreFocus: false });

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
      },
      [close, shouldHandleEvents]
    ),
    open && shouldHandleEvents
  );

  useScrollLock(modal && open && shouldHandleEvents);

  useInert(internalRef, modal && open && shouldHandleEvents);

  useEffect(() => {
    if (!open || trapFocus) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Tab') {
        close();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open, trapFocus, close]);

  const transitionAttrs = useTransitionAttrs(open, transition);

  if (anchor) {
    portal = true;
  }

  const floatingPanelProps = anchor ? getFloatingPanelProps() : {};

  const ourProps: Record<string, unknown> = {
    ...floatingPanelProps,
    id: panelId,
    ref: syncedRef,
    tabIndex: -1,
    'aria-labelledby': buttonId,
    style: {
      ...(rest.style as Record<string, unknown> | undefined),
      ...floatingStyles,
    },
    ...transitionAttrs,
  };

  if (open) {
    ourProps['data-open'] = '';
  }

  const visible = isStatic || open;
  const features = Features.RenderStrategy | Features.Static;

  const slot = { open, close };

  const inner = createElement(
    PopoverPanelContext.Provider,
    { value: panelId },
    createElement(
      CloseContext.Provider,
      { value: close },
      render({
        ourProps,
        theirProps: { as: Tag, static: isStatic, unmount, children, ...rest },
        slot,
        defaultTag: 'div',
        features,
        visible,
        name: 'PopoverPanel',
      })
    )
  );

  if (portal) {
    return createElement(Portal, { enabled: true, children: inner });
  }

  return inner;
}

PopoverPanelFn.displayName = 'PopoverPanel';
export const PopoverPanel = PopoverPanelFn;

interface PopoverGroupProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function PopoverGroupFn({ as: Tag = 'div', children, ...rest }: PopoverGroupProps) {
  const internalRef = useRef<HTMLElement | null>(null);
  const [popovers, setPopovers] = useState<PopoverRegisterBag[]>([]);

  const groupRef = useSyncRefs(
    internalRef,
    'ref' in rest ? (rest.ref as import('preact').Ref<HTMLElement>) : null
  );

  const unregisterPopover = useEvent((registerBag: PopoverRegisterBag) => {
    setPopovers((existing) => {
      const idx = existing.indexOf(registerBag);
      if (idx !== -1) {
        const clone = existing.slice();
        clone.splice(idx, 1);
        return clone;
      }
      return existing;
    });
  });

  const registerPopover = useEvent((registerBag: PopoverRegisterBag) => {
    setPopovers((existing) => [...existing, registerBag]);
    return () => unregisterPopover(registerBag);
  });

  const isFocusWithinPopoverGroup = useEvent(() => {
    const activeElement = document.activeElement as HTMLElement | null;
    if (!activeElement) return false;

    if (internalRef.current?.contains(activeElement)) return true;

    return popovers.some((bag) => {
      const buttonEl = bag.buttonId.current ? document.getElementById(bag.buttonId.current) : null;
      const panelEl = bag.panelId.current ? document.getElementById(bag.panelId.current) : null;
      return buttonEl?.contains(activeElement) || panelEl?.contains(activeElement);
    });
  });

  const closeOthers = useEvent((buttonId: string) => {
    for (const popover of popovers) {
      if (popover.buttonId.current !== buttonId) {
        popover.close();
      }
    }
  });

  const contextBag = useMemo(
    () => ({
      registerPopover,
      unregisterPopover,
      isFocusWithinPopoverGroup,
      closeOthers,
    }),
    [registerPopover, unregisterPopover, isFocusWithinPopoverGroup, closeOthers]
  );

  const slot = {};

  return createElement(
    PopoverGroupContext.Provider,
    { value: contextBag },
    render({
      ourProps: { ref: groupRef },
      theirProps: { as: Tag, children, ...rest },
      slot,
      defaultTag: 'div',
      name: 'PopoverGroup',
    })
  );
}

PopoverGroupFn.displayName = 'PopoverGroup';
/** @public */
export const PopoverGroup = PopoverGroupFn;
