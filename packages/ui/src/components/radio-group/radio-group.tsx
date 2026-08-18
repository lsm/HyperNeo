import { createContext, createElement } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { focusElement } from '../../internal/focus-management.ts';
import { Hidden } from '../../internal/hidden.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { useControllable } from '../../internal/use-controllable.ts';
import { useId } from '../../internal/use-id.ts';

function resolveCompare<T>(by?: string | ((a: T, b: T) => boolean)): (a: T, b: T) => boolean {
  if (typeof by === 'function') return by;
  if (typeof by === 'string') {
    const key = by;
    return (a: T, b: T) =>
      (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key];
  }
  return (a: T, b: T) => a === b;
}

interface RadioData {
  id: string;
  ref: { current: HTMLElement | null };
  disabled: boolean;
  value: unknown;
}

interface RadioGroupContextValue {
  value: unknown;
  setValue: (value: unknown) => void;
  disabled: boolean;
  compare: (a: unknown, b: unknown) => boolean;
  radios: RadioData[];
  registerRadio: (radio: RadioData) => () => void;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);
RadioGroupContext.displayName = 'RadioGroupContext';

function useRadioGroupContext(component: string): RadioGroupContextValue {
  const ctx = useContext(RadioGroupContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used within a <RadioGroup>`);
  }
  return ctx;
}

function sortByDomOrder<TItem extends { ref: { current: HTMLElement | null } }>(
  items: TItem[]
): TItem[] {
  return items.slice().sort((a, b) => {
    if (!a.ref.current || !b.ref.current) return 0;
    const position = a.ref.current.compareDocumentPosition(b.ref.current);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

interface RadioGroupProps<T> {
  as?: ElementType;
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  by?: string | ((a: T, b: T) => boolean);
  disabled?: boolean;
  name?: string;
  form?: string;
  children?: unknown;
  [key: string]: unknown;
}

function RadioGroupFn<T>({
  as: Tag = 'div',
  value: controlledValue,
  defaultValue,
  onChange,
  by,
  disabled = false,
  name,
  form,
  children,
  ...rest
}: RadioGroupProps<T>) {
  const [value, setValueT] = useControllable<T>(controlledValue, onChange, defaultValue as T);
  const compare = resolveCompare<T>(by);

  const [radios, setRadios] = useState<RadioData[]>([]);

  const registerRadio = useCallback((radio: RadioData) => {
    setRadios((prev) => {
      if (prev.find((r) => r.id === radio.id)) return prev;
      const next = [...prev, radio];
      return sortByDomOrder(next);
    });
    return () => {
      setRadios((prev) => prev.filter((r) => r.id !== radio.id));
    };
  }, []);

  const setValue = useCallback(
    (v: unknown) => {
      setValueT(v as T);
    },
    [setValueT]
  );

  const compareUnknown = useCallback(
    (a: unknown, b: unknown) => compare(a as T, b as T),
    [compare]
  );

  const ctx: RadioGroupContextValue = {
    value,
    setValue,
    disabled,
    compare: compareUnknown,
    radios,
    registerRadio,
  };

  const slot = { value };

  const ourProps: Record<string, unknown> = {
    role: 'radiogroup',
    ...(disabled ? { 'data-disabled': '' } : {}),
  };

  const stringValue = value !== undefined && value !== null ? String(value) : '';

  return createElement(
    RadioGroupContext.Provider,
    { value: ctx },
    render({
      ourProps,
      theirProps: { as: Tag, children, ...rest },
      slot,
      defaultTag: 'div',
      name: 'RadioGroup',
    }),
    createElement(Hidden, { name, value: stringValue, form })
  );
}

RadioGroupFn.displayName = 'RadioGroup';
const RadioGroupWithName = RadioGroupFn as typeof RadioGroupFn & { displayName: string };
RadioGroupWithName.displayName = 'RadioGroup';
export const RadioGroup = RadioGroupWithName;

interface RadioProps<T> {
  as?: ElementType;
  value: T;
  disabled?: boolean;
  autoFocus?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function RadioFn<T>({
  as: Tag = 'span',
  value: radioValue,
  disabled: individualDisabled = false,
  autoFocus = false,
  children,
  ...rest
}: RadioProps<T>) {
  const ctx = useRadioGroupContext('Radio');
  const { value, setValue, disabled: groupDisabled, compare, radios, registerRadio } = ctx;

  const id = useId();
  const ref = useRef<HTMLElement | null>(null);

  const disabled = groupDisabled || individualDisabled;
  const checked = value !== undefined && value !== null ? compare(value, radioValue) : false;

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const radioData: RadioData = { id, ref, disabled, value: radioValue };
    return registerRadio(radioData);
  }, [id, registerRadio, disabled, radioValue]);

  const myIndex = radios.findIndex((r) => r.id === id);
  const hasChecked = radios.some((r) => r.value !== undefined && compare(value, r.value));
  const firstNonDisabledIndex = radios.findIndex((r) => !r.disabled);

  let tabIndex: number;
  if (checked) {
    tabIndex = 0;
  } else if (!hasChecked && myIndex === firstNonDisabledIndex) {
    tabIndex = 0;
  } else {
    tabIndex = -1;
  }

  const getNextNonDisabledIndex = useCallback(
    (from: number, direction: 1 | -1): number => {
      const count = radios.length;
      for (let i = 1; i <= count; i++) {
        const idx = (from + direction * i + count) % count;
        const radio = radios[idx];
        if (radio && !radio.disabled) return idx;
      }
      return from;
    },
    [radios]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (disabled || myIndex === -1) return;

      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowRight': {
          e.preventDefault();
          const nextIdx = getNextNonDisabledIndex(myIndex, 1);
          const nextRadio = radios[nextIdx];
          if (nextRadio) {
            focusElement(nextRadio.ref.current);
            setValue(nextRadio.value);
          }
          break;
        }
        case 'ArrowUp':
        case 'ArrowLeft': {
          e.preventDefault();
          const prevIdx = getNextNonDisabledIndex(myIndex, -1);
          const prevRadio = radios[prevIdx];
          if (prevRadio) {
            focusElement(prevRadio.ref.current);
            setValue(prevRadio.value);
          }
          break;
        }
        case ' ': {
          e.preventDefault();
          if (!checked) {
            setValue(radioValue);
          }
          break;
        }
        default:
          break;
      }
    },
    [disabled, myIndex, radios, getNextNonDisabledIndex, setValue, checked, radioValue]
  );

  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      setValue(radioValue);
    },
    [disabled, setValue, radioValue]
  );

  const ourProps: Record<string, unknown> = {
    id,
    ref,
    role: 'radio',
    'aria-checked': checked,
    tabIndex,
    autoFocus,
    onClick: handleClick,
    onKeyDown: handleKeyDown,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    onMouseDown: () => setActive(true),
    onMouseUp: () => setActive(false),
  };

  const slot = {
    checked,
    disabled,
    hover,
    focus,
    active,
    autofocus: autoFocus,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'span',
    name: 'Radio',
  });
}

RadioFn.displayName = 'Radio';
const RadioWithName = RadioFn as typeof RadioFn & { displayName: string };
RadioWithName.displayName = 'Radio';
export const Radio = RadioWithName;
