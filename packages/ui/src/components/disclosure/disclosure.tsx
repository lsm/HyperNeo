import { createContext, createElement, Fragment } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { OpenClosedContext, State } from '../../internal/open-closed.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { Features } from '../../internal/types.ts';
import { useEvent } from '../../internal/use-event.ts';
import { useId } from '../../internal/use-id.ts';
import { optionalRef, useSyncRefs } from '../../internal/use-sync-refs.ts';

interface DisclosureState {
  open: boolean;
  toggle: () => void;
  close: (focusRef?: { current: HTMLElement | null }) => void;
  buttonId: string;
  panelId: string;
  buttonRef: { current: HTMLElement | null };
  panelRef: { current: HTMLElement | null };
}

const DisclosureContext = createContext<DisclosureState | null>(null);
DisclosureContext.displayName = 'DisclosureContext';

// Context to track if a button is inside a panel
const DisclosurePanelContext = createContext<string | null>(null);
DisclosurePanelContext.displayName = 'DisclosurePanelContext';

function useDisclosureContext(component: string): DisclosureState {
  const ctx = useContext(DisclosureContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used within a <Disclosure>`);
  }
  return ctx;
}

// --- Disclosure (root) ---

interface DisclosureProps {
  as?: ElementType;
  defaultOpen?: boolean;
  open?: boolean;
  onChange?: (open: boolean) => void;
  children?: unknown;
  [key: string]: unknown;
}

function DisclosureFn({
  as: Tag = Fragment,
  defaultOpen = false,
  open: controlledOpen,
  onChange,
  children,
  ...rest
}: DisclosureProps) {
  // Controlled mode: use provided `open` prop; otherwise use internal state
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const buttonId = useId();
  const panelId = useId();
  const buttonRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const internalRef = useRef<HTMLElement | null>(null);

  // Stable onChange handler
  const handleChange = useEvent((newValue: boolean) => {
    if (!isControlled) {
      setInternalOpen(newValue);
    }
    onChange?.(newValue);
  });

  const toggle = useCallback(() => {
    handleChange(!open);
  }, [open, handleChange]);

  const close = useCallback(
    (focusRef?: { current: HTMLElement | null }) => {
      handleChange(false);
      const target = focusRef?.current ?? buttonRef.current;
      if (target) {
        target.focus();
      }
    },
    [handleChange]
  );

  const ctx: DisclosureState = useMemo(
    () => ({ open, toggle, close, buttonId, panelId, buttonRef, panelRef }),
    [open, toggle, close, buttonId, panelId]
  );

  const slot = useMemo(() => ({ open, close }), [open, close]);

  // Ref forwarding for the root Disclosure element
  const disclosureRef = useSyncRefs(
    'ref' in rest ? (rest.ref as import('preact').Ref<HTMLElement>) : null,
    optionalRef((ref) => {
      internalRef.current = ref;
    }, Tag === Fragment)
  );

  const ourProps = Tag === Fragment ? {} : { ref: disclosureRef };
  const theirProps = { as: Tag, ...rest, children };

  return createElement(
    DisclosureContext.Provider,
    { value: ctx },
    createElement(
      OpenClosedContext.Provider,
      { value: open ? State.Open : State.Closed },
      render({
        ourProps,
        theirProps,
        slot,
        defaultTag: Fragment,
        name: 'Disclosure',
      })
    )
  );
}

DisclosureFn.displayName = 'Disclosure';
export const Disclosure = DisclosureFn;

// --- DisclosureButton ---

interface DisclosureButtonProps {
  as?: ElementType;
  autoFocus?: boolean;
  disabled?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function DisclosureButtonFn({
  as: Tag = 'button',
  autoFocus = false,
  disabled = false,
  children,
  ...rest
}: DisclosureButtonProps) {
  const { open, toggle, close, panelId, buttonId, buttonRef } =
    useDisclosureContext('DisclosureButton');

  // Check if button is inside a panel
  const panelContext = useContext(DisclosurePanelContext);
  const isWithinPanel = panelContext !== null;

  // Internal ref to track the actual button element
  const internalButtonRef = useRef<HTMLElement | null>(null);

  // Extract external ref from rest props (Preact style)
  const externalRef = 'ref' in rest ? (rest.ref as import('preact').Ref<HTMLElement>) : null;

  // Sync refs
  const syncedRef = useSyncRefs(
    internalButtonRef,
    externalRef,
    optionalRef((el: HTMLElement) => {
      // Only set buttonRef if not inside panel
      if (!isWithinPanel) {
        buttonRef.current = el;
      }
    })
  );

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(false);

  // Resolve button type - if it's a button element and no type is specified, use "button"
  const type = useMemo(() => {
    // If type is explicitly provided, use it
    if ('type' in rest && rest.type !== undefined) {
      return rest.type as string;
    }
    // If `as` prop is provided and it's not a string 'button', don't add type
    if (Tag !== 'button') {
      return undefined;
    }
    // Default to type="button" for button elements
    return 'button';
  }, [Tag, rest]);

  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      if (isWithinPanel) {
        // When inside panel, clicking closes the disclosure
        close();
        // Focus the button outside the panel
        buttonRef.current?.focus();
      } else {
        toggle();
      }
    },
    [disabled, toggle, close, isWithinPanel, buttonRef]
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
          toggle();
        }
      }
    },
    [disabled, toggle, close, isWithinPanel, buttonRef]
  );

  // Firefox space key fix - prevent space from triggering click after preventDefault in keydown
  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
    }
  }, []);

  const slot = useMemo(
    () => ({ open, hover, focus, active, autofocus: autoFocus, disabled }),
    [open, hover, focus, active, autoFocus, disabled]
  );

  // When button is inside panel, it acts as a close button without aria attributes
  const ourProps: Record<string, unknown> = isWithinPanel
    ? {
        ref: syncedRef,
        type,
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
        ref: syncedRef,
        id: buttonId,
        type,
        'aria-expanded': open,
        'aria-controls': panelId,
        disabled: disabled || undefined,
        autoFocus,
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

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'button',
    name: 'DisclosureButton',
  });
}

DisclosureButtonFn.displayName = 'DisclosureButton';
export const DisclosureButton = DisclosureButtonFn;

// --- DisclosurePanel ---

interface DisclosurePanelProps {
  as?: ElementType;
  transition?: boolean;
  static?: boolean;
  unmount?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function DisclosurePanelFn({
  as: Tag = 'div',
  transition = false,
  static: isStatic = false,
  unmount = true,
  children,
  ...rest
}: DisclosurePanelProps) {
  const { open, close, panelId, panelRef } = useDisclosureContext('DisclosurePanel');

  // Extract external ref from rest props (Preact style)
  const externalRef = 'ref' in rest ? (rest.ref as import('preact').Ref<HTMLElement>) : null;

  // Sync refs
  const syncedRef = useSyncRefs(
    panelRef,
    externalRef,
    optionalRef((el: HTMLElement) => {
      panelRef.current = el;
    })
  );

  // Transition data attribute state
  const [transitionAttrs, setTransitionAttrs] = useState<{
    'data-transition'?: '';
    'data-enter'?: '';
    'data-leave'?: '';
    'data-closed'?: '';
  }>({});

  const prevOpenRef = useRef(open);

  useEffect(() => {
    if (!transition) {
      setTransitionAttrs({});
      return;
    }

    const prev = prevOpenRef.current;
    prevOpenRef.current = open;

    if (open && !prev) {
      // Opening: data-enter + data-transition for one frame, then remove
      setTransitionAttrs({ 'data-transition': '', 'data-enter': '' });
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTransitionAttrs({});
        });
      });
      return () => cancelAnimationFrame(raf);
    }

    if (!open && prev) {
      // Closing: data-leave + data-transition + data-closed, then clear
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

  const slot = useMemo(() => ({ open, close }), [open, close]);

  const ourProps: Record<string, unknown> = {
    id: panelId,
    ref: syncedRef,
    ...transitionAttrs,
  };

  const visible = isStatic || open;

  const features = Features.RenderStrategy | Features.Static;

  // Provide panel context so buttons inside can detect they're in a panel
  return createElement(
    DisclosurePanelContext.Provider,
    { value: panelId },
    render({
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
      visible,
      name: 'DisclosurePanel',
    })
  );
}

DisclosurePanelFn.displayName = 'DisclosurePanel';
export const DisclosurePanel = DisclosurePanelFn;
