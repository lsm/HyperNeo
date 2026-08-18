import type { RefObject } from 'preact';
import { createContext, createElement } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { OpenClosedContext, State } from '../../internal/open-closed.ts';
import { Portal } from '../../internal/portal.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { Features } from '../../internal/types.ts';
import { useEscape } from '../../internal/use-escape.ts';
import { useFocusTrap } from '../../internal/use-focus-trap.ts';
import { useId } from '../../internal/use-id.ts';
import { useInert } from '../../internal/use-inert.ts';
import { useOutsideClick } from '../../internal/use-outside-click.ts';
import { useScrollLock } from '../../internal/use-scroll-lock.ts';
import { useEvent } from '../../internal/use-event.ts';
import { useIsoMorphicEffect } from '../../internal/use-iso-morphic-effect.ts';
import { stackMachines } from '../../internal/stack-machine.ts';

interface DialogState {
  open: boolean;
  onClose: (value: boolean) => void;
  dialogRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  titleId: string | null;
  setTitleId: (id: string | null) => void;
  descriptionId: string | null;
  setDescriptionId: (id: string | null) => void;
}

const DialogContext = createContext<DialogState | null>(null);
DialogContext.displayName = 'DialogContext';

function useDialogContext(component: string): DialogState {
  const ctx = useContext(DialogContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used within a <Dialog>`);
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

interface DialogProps {
  open: boolean;
  onClose: (value: boolean) => void;
  role?: 'dialog' | 'alertdialog';
  autoFocus?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  as?: ElementType;
  transition?: boolean;
  static?: boolean;
  unmount?: boolean;
  __demoMode?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function DialogFn({
  open,
  onClose,
  role = 'dialog',
  autoFocus = true,
  initialFocus,
  as: Tag = 'div',
  transition = false,
  static: isStatic = false,
  unmount = true,
  __demoMode = false,
  children,
  ...rest
}: DialogProps) {
  const internalId = useId();
  const id = `headlessui-dialog-${internalId}`;

  const dialogRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const [titleId, setTitleId] = useState<string | null>(null);
  const [descriptionId, setDescriptionId] = useState<string | null>(null);

  const handleClose = useCallback(
    (value: boolean) => {
      onClose(value);
    },
    [onClose]
  );

  const stackMachine = stackMachines.get(null);

  useIsoMorphicEffect(() => {
    if (!open) return;

    stackMachine.actions.push(id);
    return () => stackMachine.actions.pop(id);
  }, [stackMachine, id, open]);

  const isTopLayerRef = useRef(true);
  useIsoMorphicEffect(() => {
    isTopLayerRef.current = stackMachine.selectors.isTop(stackMachine.state, id);
  });

  const shouldHandleEvents =
    open && (isTopLayerRef.current || !stackMachine.selectors.inStack(stackMachine.state, id));

  useFocusTrap(panelRef, open && autoFocus && !__demoMode, {
    initialFocus,
    restoreFocus: !__demoMode,
  });

  useScrollLock(open && !__demoMode);

  useInert(dialogRef, open);

  useEscape(
    useCallback(() => {
      if (!shouldHandleEvents) return;
      handleClose(false);
    }, [shouldHandleEvents, handleClose]),
    open
  );

  useOutsideClick(
    [panelRef],
    useCallback(() => {
      if (!shouldHandleEvents) return;
      handleClose(false);
    }, [shouldHandleEvents, handleClose]),
    open
  );

  const transitionAttrs = useTransitionAttrs(open, transition);

  const slot = { open };

  const ourProps: Record<string, unknown> = {
    id,
    ref: dialogRef,
    role,
    tabIndex: -1,
    'aria-modal': __demoMode ? undefined : open ? true : undefined,
    'aria-labelledby': titleId ?? undefined,
    'aria-describedby': descriptionId ?? undefined,
    ...transitionAttrs,
  };

  const ctx: DialogState = {
    open,
    onClose: handleClose,
    dialogRef,
    panelRef,
    titleId,
    setTitleId,
    descriptionId,
    setDescriptionId,
  };

  const visible = isStatic || open;
  const features = Features.RenderStrategy | Features.Static;

  const inner = render({
    ourProps,
    theirProps: { as: Tag, static: isStatic, unmount, children, ...rest },
    slot,
    defaultTag: 'div',
    features,
    visible,
    name: 'Dialog',
  });

  const content = createElement(
    DialogContext.Provider,
    { value: ctx },
    createElement(OpenClosedContext.Provider, { value: open ? State.Open : State.Closed }, inner)
  );

  return createElement(Portal, { enabled: true, children: content });
}

DialogFn.displayName = 'Dialog';
export const Dialog = DialogFn;

interface DialogPanelProps {
  as?: ElementType;
  transition?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function DialogPanelFn({
  as: Tag = 'div',
  transition = false,
  children,
  ...rest
}: DialogPanelProps) {
  const { open, panelRef } = useDialogContext('DialogPanel');
  const id = useId();
  const panelId = `headlessui-dialog-panel-${id}`;

  const transitionAttrs = useTransitionAttrs(open, transition);

  const slot = { open };

  const handleClick = useEvent((event: MouseEvent) => {
    event.stopPropagation();
  });

  const ourProps: Record<string, unknown> = {
    id: panelId,
    ref: panelRef,
    onClick: handleClick,
    ...transitionAttrs,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'div',
    name: 'DialogPanel',
  });
}

DialogPanelFn.displayName = 'DialogPanel';
export const DialogPanel = DialogPanelFn;

interface DialogTitleProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function DialogTitleFn({ as: Tag = 'h2', children, ...rest }: DialogTitleProps) {
  const { open, setTitleId } = useDialogContext('DialogTitle');
  const id = useId();
  const titleId = `headlessui-dialog-title-${id}`;

  useEffect(() => {
    setTitleId(titleId);
    return () => setTitleId(null);
  }, [titleId, setTitleId]);

  const slot = { open };

  const ourProps: Record<string, unknown> = {
    id: titleId,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'h2',
    name: 'DialogTitle',
  });
}

DialogTitleFn.displayName = 'DialogTitle';
export const DialogTitle = DialogTitleFn;

interface DialogDescriptionProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function DialogDescriptionFn({ as: Tag = 'p', children, ...rest }: DialogDescriptionProps) {
  const { open, setDescriptionId } = useDialogContext('DialogDescription');
  const id = useId();
  const descriptionId = `headlessui-dialog-description-${id}`;

  useEffect(() => {
    setDescriptionId(descriptionId);
    return () => setDescriptionId(null);
  }, [descriptionId, setDescriptionId]);

  const slot = { open };

  const ourProps: Record<string, unknown> = {
    id: descriptionId,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'p',
    name: 'DialogDescription',
  });
}

DialogDescriptionFn.displayName = 'DialogDescription';
export const DialogDescription = DialogDescriptionFn;

interface DialogBackdropProps {
  as?: ElementType;
  transition?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function DialogBackdropFn({
  as: Tag = 'div',
  transition = false,
  children,
  ...rest
}: DialogBackdropProps) {
  const { open, onClose } = useDialogContext('DialogBackdrop');
  const transitionAttrs = useTransitionAttrs(open, transition);

  const slot = { open };

  const handleClick = useEvent(() => {
    onClose(false);
  });

  const ourProps: Record<string, unknown> = {
    'aria-hidden': true,
    onClick: handleClick,
    ...transitionAttrs,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'div',
    name: 'DialogBackdrop',
  });
}

DialogBackdropFn.displayName = 'DialogBackdrop';
export const DialogBackdrop = DialogBackdropFn;

interface CloseButtonProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function CloseButtonFn({ as: Tag = 'button', children, ...rest }: CloseButtonProps) {
  const { onClose } = useDialogContext('CloseButton');

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(false);

  const handleClick = useEvent(() => {
    onClose(false);
  });

  const slot = { hover, focus, active };

  const ourProps: Record<string, unknown> = {
    onClick: handleClick,
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
    name: 'CloseButton',
  });
}

CloseButtonFn.displayName = 'CloseButton';
export const CloseButton = CloseButtonFn;
