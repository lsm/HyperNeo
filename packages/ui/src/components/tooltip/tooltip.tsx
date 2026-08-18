import type { RefObject } from 'preact';
import { createContext, createElement } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { Features } from '../../internal/types.ts';
import { useId } from '../../internal/use-id.ts';

interface TooltipState {
  open: boolean;
  show: () => void;
  hide: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  triggerId: string;
  panelId: string;
}

const TooltipContext = createContext<TooltipState | null>(null);
TooltipContext.displayName = 'TooltipContext';

function useTooltipContext(component: string): TooltipState {
  const ctx = useContext(TooltipContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used within a <Tooltip>`);
  }
  return ctx;
}

interface TooltipProps {
  as?: ElementType;
  showDelay?: number;
  hideDelay?: number;
  children?: unknown;
  [key: string]: unknown;
}

function TooltipFn({
  as: Tag = 'div',
  showDelay = 500,
  hideDelay = 0,
  children,
  ...rest
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  const panelId = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (showTimerRef.current !== null) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const show = useCallback(() => {
    clearTimers();
    if (showDelay === 0) {
      setOpen(true);
    } else {
      showTimerRef.current = setTimeout(() => {
        setOpen(true);
      }, showDelay);
    }
  }, [clearTimers, showDelay]);

  const hide = useCallback(() => {
    clearTimers();
    if (hideDelay === 0) {
      setOpen(false);
    } else {
      hideTimerRef.current = setTimeout(() => {
        setOpen(false);
      }, hideDelay);
    }
  }, [clearTimers, hideDelay]);

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  const ctx: TooltipState = {
    open,
    show,
    hide,
    triggerRef,
    panelRef,
    triggerId,
    panelId,
  };

  const slot = { open };

  return createElement(
    TooltipContext.Provider,
    { value: ctx },
    render({
      ourProps: {},
      theirProps: { as: Tag, children, ...rest },
      slot,
      defaultTag: 'div',
      name: 'Tooltip',
    })
  );
}

TooltipFn.displayName = 'Tooltip';
export const Tooltip = TooltipFn;

interface TooltipTriggerProps {
  as?: ElementType;
  disabled?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function TooltipTriggerFn({
  as: Tag = 'button',
  disabled = false,
  children,
  ...rest
}: TooltipTriggerProps) {
  const { open, show, hide, triggerRef, panelId } = useTooltipContext('TooltipTrigger');

  const handleMouseEnter = useCallback(() => {
    if (disabled) return;
    show();
  }, [disabled, show]);

  const handleMouseLeave = useCallback(() => {
    hide();
  }, [hide]);

  const handleFocus = useCallback(() => {
    if (disabled) return;
    show();
  }, [disabled, show]);

  const handleBlur = useCallback(() => {
    hide();
  }, [hide]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        hide();
      }
    },
    [open, hide]
  );

  const ourProps: Record<string, unknown> = {
    ref: triggerRef,
    'aria-describedby': open ? panelId : undefined,
    disabled: disabled || undefined,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onKeyDown: handleKeyDown,
  };

  if (open) {
    ourProps['data-open'] = '';
  } else {
    ourProps['data-closed'] = '';
  }

  const slot = { open };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'button',
    name: 'TooltipTrigger',
  });
}

TooltipTriggerFn.displayName = 'TooltipTrigger';
export const TooltipTrigger = TooltipTriggerFn;

interface TooltipPanelProps {
  as?: ElementType;
  static?: boolean;
  unmount?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function TooltipPanelFn({
  as: Tag = 'div',
  static: isStatic = false,
  unmount = true,
  children,
  ...rest
}: TooltipPanelProps) {
  const { open, panelRef, panelId } = useTooltipContext('TooltipPanel');

  const ourProps: Record<string, unknown> = {
    id: panelId,
    ref: panelRef,
    role: 'tooltip',
  };

  if (open) {
    ourProps['data-open'] = '';
  } else {
    ourProps['data-closed'] = '';
  }

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
    name: 'TooltipPanel',
  });
}

TooltipPanelFn.displayName = 'TooltipPanel';
export const TooltipPanel = TooltipPanelFn;
