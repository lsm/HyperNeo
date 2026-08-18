import { createContext, createElement } from 'preact';
import { useCallback, useContext, useRef, useState } from 'preact/hooks';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';

interface InputGroupContextValue {
  disabled: boolean;
  hover: boolean;
  focus: boolean;
}

const InputGroupContext = createContext<InputGroupContextValue | null>(null);
InputGroupContext.displayName = 'InputGroupContext';

export function useInputGroupContext(): InputGroupContextValue | null {
  return useContext(InputGroupContext);
}

interface InputGroupProps {
  as?: ElementType;
  disabled?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function InputGroupFn({ as: Tag = 'div', disabled = false, children, ...rest }: InputGroupProps) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const focusCountRef = useRef(0);

  const handleFocusIn = useCallback(() => {
    focusCountRef.current++;
    setFocus(true);
  }, []);

  const handleFocusOut = useCallback(() => {
    focusCountRef.current--;
    if (focusCountRef.current <= 0) {
      focusCountRef.current = 0;
      setFocus(false);
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    setHover(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHover(false);
  }, []);

  const ctx: InputGroupContextValue = {
    disabled,
    hover,
    focus,
  };

  const slot = { disabled, hover, focus };

  const ourProps: Record<string, unknown> = {
    onFocusIn: handleFocusIn,
    onFocusOut: handleFocusOut,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
  };

  return createElement(
    InputGroupContext.Provider,
    { value: ctx },
    render({
      ourProps,
      theirProps: { as: Tag, children, ...rest },
      slot,
      defaultTag: 'div',
      name: 'InputGroup',
    })
  );
}

InputGroupFn.displayName = 'InputGroup';
export const InputGroup = InputGroupFn;

interface InputAddonProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function InputAddonFn({ as: Tag = 'div', children, ...rest }: InputAddonProps) {
  const groupCtx = useContext(InputGroupContext);

  const slot = {
    disabled: groupCtx?.disabled ?? false,
    hover: groupCtx?.hover ?? false,
    focus: groupCtx?.focus ?? false,
  };

  const ourProps: Record<string, unknown> = {};

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'div',
    name: 'InputAddon',
  });
}

InputAddonFn.displayName = 'InputAddon';
export const InputAddon = InputAddonFn;
