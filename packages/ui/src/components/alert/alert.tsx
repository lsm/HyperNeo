import { createContext, createElement } from 'preact';
import { useCallback, useContext, useEffect, useState } from 'preact/hooks';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { useId } from '../../internal/use-id.ts';

interface AlertContextValue {
  open: boolean;
  variant: string;
  dismissible: boolean;
  dismiss: () => void;
  titleId: string | null;
  setTitleId: (id: string | null) => void;
  descriptionId: string | null;
  setDescriptionId: (id: string | null) => void;
}

const AlertContext = createContext<AlertContextValue | null>(null);
AlertContext.displayName = 'AlertContext';

function useAlertContext(component: string): AlertContextValue {
  const ctx = useContext(AlertContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used within an <Alert>`);
  }
  return ctx;
}

type AlertVariant = 'info' | 'success' | 'warning' | 'error';

interface AlertProps {
  variant?: AlertVariant;
  dismissible?: boolean;
  onDismiss?: () => void;
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function AlertFn({
  variant = 'info',
  dismissible = false,
  onDismiss,
  as: Tag = 'div',
  children,
  ...rest
}: AlertProps) {
  const [open, setOpen] = useState(true);
  const [titleId, setTitleId] = useState<string | null>(null);
  const [descriptionId, setDescriptionId] = useState<string | null>(null);

  const dismiss = useCallback(() => {
    setOpen(false);
    onDismiss?.();
  }, [onDismiss]);

  const ctx: AlertContextValue = {
    open,
    variant,
    dismissible,
    dismiss,
    titleId,
    setTitleId,
    descriptionId,
    setDescriptionId,
  };

  const slot = { open, variant, dismissible };

  const ourProps: Record<string, unknown> = {
    role: 'alert',
    'aria-labelledby': titleId ?? undefined,
    'aria-describedby': descriptionId ?? undefined,
    hidden: open ? undefined : true,
    'data-variant': variant,
    'data-dismissible': dismissible || undefined,
  };

  const inner = render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'div',
    name: 'Alert',
  });

  return createElement(AlertContext.Provider, { value: ctx }, inner);
}

AlertFn.displayName = 'Alert';
export const Alert = AlertFn;

interface AlertIconProps {
  as?: ElementType;
  icon?: unknown;
  children?: unknown;
  [key: string]: unknown;
}

function AlertIconFn({ as: Tag = 'div', icon, children, ...rest }: AlertIconProps) {
  const { variant } = useAlertContext('AlertIcon');

  const slot = {};

  const iconPaths: Record<string, preact.ComponentChildren> = {
    info: createElement('path', {
      'fill-rule': 'evenodd',
      d: 'M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z',
      'clip-rule': 'evenodd',
    }),
    success: createElement('path', {
      'fill-rule': 'evenodd',
      d: 'M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z',
      'clip-rule': 'evenodd',
    }),
    warning: createElement('path', {
      'fill-rule': 'evenodd',
      d: 'M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z',
      'clip-rule': 'evenodd',
    }),
    error: createElement('path', {
      'fill-rule': 'evenodd',
      d: 'M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z',
      'clip-rule': 'evenodd',
    }),
  };

  const iconContent =
    icon ??
    createElement('svg', {
      'aria-hidden': 'true',
      viewBox: '0 0 20 20',
      fill: 'currentColor',
      children: iconPaths[variant] || iconPaths.info,
    });

  const ourProps: Record<string, unknown> = {
    'data-slot': 'icon',
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children: children ?? iconContent, ...rest },
    slot,
    defaultTag: 'div',
    name: 'AlertIcon',
  });
}

AlertIconFn.displayName = 'AlertIcon';
export const AlertIcon = AlertIconFn;

interface AlertTitleProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function AlertTitleFn({ as: Tag = 'h3', children, ...rest }: AlertTitleProps) {
  const { open, setTitleId } = useAlertContext('AlertTitle');
  const id = useId();

  useEffect(() => {
    setTitleId(id);
    return () => setTitleId(null);
  }, [id, setTitleId]);

  const slot = { open };

  const ourProps: Record<string, unknown> = {
    id,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'h3',
    name: 'AlertTitle',
  });
}

AlertTitleFn.displayName = 'AlertTitle';
export const AlertTitle = AlertTitleFn;

interface AlertDescriptionProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function AlertDescriptionFn({ as: Tag = 'p', children, ...rest }: AlertDescriptionProps) {
  const { open, setDescriptionId } = useAlertContext('AlertDescription');
  const id = useId();

  useEffect(() => {
    setDescriptionId(id);
    return () => setDescriptionId(null);
  }, [id, setDescriptionId]);

  const slot = { open };

  const ourProps: Record<string, unknown> = {
    id,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'p',
    name: 'AlertDescription',
  });
}

AlertDescriptionFn.displayName = 'AlertDescription';
export const AlertDescription = AlertDescriptionFn;

interface AlertActionsProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function AlertActionsFn({ as: Tag = 'div', children, ...rest }: AlertActionsProps) {
  const { open } = useAlertContext('AlertActions');

  const slot = { open };

  const ourProps: Record<string, unknown> = {
    'data-slot': 'actions',
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'div',
    name: 'AlertActions',
  });
}

AlertActionsFn.displayName = 'AlertActions';
export const AlertActions = AlertActionsFn;
