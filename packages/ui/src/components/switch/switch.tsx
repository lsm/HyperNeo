import { createElement } from 'preact';
import { useCallback, useRef, useState } from 'preact/hooks';
import { Hidden } from '../../internal/hidden.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { useControllable } from '../../internal/use-controllable.ts';
import { useId } from '../../internal/use-id.ts';

interface SwitchProps {
  as?: ElementType;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  value?: string;
  form?: string;
  autoFocus?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function SwitchFn({
  as: Tag = 'button',
  checked: controlledChecked,
  defaultChecked = false,
  onChange,
  disabled = false,
  name,
  value = 'on',
  form,
  autoFocus = false,
  children,
  ...rest
}: SwitchProps) {
  const id = useId();
  const [checked, setChecked] = useControllable(controlledChecked, onChange, defaultChecked);

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(false);
  const [changing, setChanging] = useState(false);
  const changingRafRef = useRef<number | null>(null);

  const toggle = useCallback(() => {
    if (disabled) return;
    const next = !checked;
    setChecked(next);
    setChanging(true);
    if (changingRafRef.current !== null) {
      cancelAnimationFrame(changingRafRef.current);
    }
    changingRafRef.current = requestAnimationFrame(() => {
      setChanging(false);
      changingRafRef.current = null;
    });
  }, [disabled, checked, setChecked]);

  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      toggle();
    },
    [disabled, toggle]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (disabled) return;
      if (e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'Enter') {
        const form = (e.currentTarget as HTMLElement)?.closest('form');
        if (form) {
          const submitter = form.querySelector<HTMLButtonElement>('[type="submit"]');
          if (submitter) {
            submitter.click();
          } else {
            form.requestSubmit?.();
          }
        }
      }
    },
    [disabled, toggle]
  );

  const ourProps: Record<string, unknown> = {
    id,
    role: 'switch',
    'aria-checked': checked,
    tabIndex: 0,
    autoFocus,
    disabled: disabled || undefined,
    onClick: handleClick,
    onKeyDown: handleKeyDown,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    onMouseDown: () => setActive(true),
    onMouseUp: () => setActive(false),
  };

  const slot = { checked, disabled, hover, focus, active, autofocus: autoFocus, changing };

  return createElement(
    'span',
    null,
    render({
      ourProps,
      theirProps: { as: Tag, children, ...rest },
      slot,
      defaultTag: 'button',
      name: 'Switch',
    }),
    createElement(Hidden, {
      name,
      value: checked ? value : undefined,
      form,
    })
  );
}

SwitchFn.displayName = 'Switch';
export const Switch = SwitchFn;
