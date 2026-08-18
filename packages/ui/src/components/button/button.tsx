import { useContext, useRef, useState } from 'preact/hooks';
import { CloseContext } from '../../hooks/use-close.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';

interface FocusEventWithCapabilities extends FocusEvent {
  sourceCapabilities?: { firesTouchEvents: boolean };
}

interface ButtonProps {
  as?: ElementType;
  type?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function ButtonFn({
  as: Tag = 'button',
  type,
  disabled = false,
  autoFocus = false,
  children,
  ...rest
}: ButtonProps) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(false);
  const isTouch = useRef(false);

  const resolvedType = Tag === 'button' ? (type ?? 'button') : type;

  const ourProps: Record<string, unknown> = {
    autoFocus,
    disabled: disabled || undefined,
    ...(resolvedType !== undefined ? { type: resolvedType } : {}),
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      setHover(true);
    },
    onPointerLeave: (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      setHover(false);
    },
    onPointerDown: (e: PointerEvent) => {
      isTouch.current = e.pointerType === 'touch';
      setActive(true);
    },
    onPointerUp: () => {
      setActive(false);
    },
    onFocus: (e: FocusEventWithCapabilities) => {
      if (e.sourceCapabilities?.firesTouchEvents === true) {
        return;
      }
      if (isTouch.current) return;
      setFocus(true);
    },
    onBlur: () => {
      setFocus(false);
    },
  };

  const slot = { hover, focus, active, autofocus: autoFocus, disabled };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'button',
    name: 'Button',
  });
}

ButtonFn.displayName = 'Button';
export const Button = ButtonFn;

interface CloseButtonProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function CloseButtonFn({ as: Tag = 'button', children, ...rest }: CloseButtonProps) {
  const close = useContext(CloseContext);

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(false);
  const isTouch = useRef(false);

  const ourProps: Record<string, unknown> = {
    type: Tag === 'button' ? 'button' : undefined,
    onClick: () => {
      if (close) close();
    },
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      setHover(true);
    },
    onPointerLeave: (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      setHover(false);
    },
    onPointerDown: (e: PointerEvent) => {
      isTouch.current = e.pointerType === 'touch';
      setActive(true);
    },
    onPointerUp: () => {
      setActive(false);
    },
    onFocus: (e: FocusEventWithCapabilities) => {
      if (e.sourceCapabilities?.firesTouchEvents === true) {
        return;
      }
      if (isTouch.current) return;
      setFocus(true);
    },
    onBlur: () => {
      setFocus(false);
    },
  };

  const slot = { hover, focus, active, autofocus: false, disabled: false };

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

interface DataInteractiveProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function DataInteractiveFn({ as: Tag = 'div', children, ...rest }: DataInteractiveProps) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const isTouch = useRef(false);

  const ourProps: Record<string, unknown> = {
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      setHover(true);
    },
    onPointerLeave: (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      setHover(false);
    },
    onPointerDown: (e: PointerEvent) => {
      isTouch.current = e.pointerType === 'touch';
    },
    onFocus: (e: FocusEventWithCapabilities) => {
      if (e.sourceCapabilities?.firesTouchEvents === true) {
        return;
      }
      if (isTouch.current) return;
      setFocus(true);
    },
    onBlur: () => {
      setFocus(false);
    },
  };

  const slot = { hover, focus };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'div',
    name: 'DataInteractive',
  });
}

DataInteractiveFn.displayName = 'DataInteractive';
export const DataInteractive = DataInteractiveFn;

interface ButtonGroupProps {
  as?: ElementType;
  children?: unknown;
  'aria-label'?: string;
  [key: string]: unknown;
}

function ButtonGroupFn({
  as: Tag = 'div',
  children,
  'aria-label': ariaLabel,
  ...rest
}: ButtonGroupProps) {
  const ourProps: Record<string, unknown> = {
    role: 'group',
    'data-slot': 'button-group',
    ...(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {}),
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot: {},
    defaultTag: 'div',
    name: 'ButtonGroup',
  });
}

ButtonGroupFn.displayName = 'ButtonGroup';
export const ButtonGroup = ButtonGroupFn;
