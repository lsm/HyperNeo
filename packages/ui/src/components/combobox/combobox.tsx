import type { RefObject } from 'preact';
import { createContext, createElement, Fragment } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import {
  ActivationTrigger,
  calculateActiveIndex,
  Focus,
} from '../../internal/calculate-active-index.ts';
import { Hidden } from '../../internal/hidden.ts';
import { OpenClosedContext, State } from '../../internal/open-closed.ts';
import { Portal } from '../../internal/portal.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { Features } from '../../internal/types.ts';
import { useControllable } from '../../internal/use-controllable.ts';
import { useId } from '../../internal/use-id.ts';
import { useOutsideClick } from '../../internal/use-outside-click.ts';
import { useTextValue } from '../../internal/use-text-value.ts';
import { useTrackedPointer } from '../../internal/use-tracked-pointer.ts';

function resolveCompare<T>(by?: string | ((a: T, b: T) => boolean)): (a: T, b: T) => boolean {
  if (typeof by === 'function') return by;
  if (typeof by === 'string') {
    const key = by;
    return (a: T, b: T) =>
      (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key];
  }
  return (a: T, b: T) => a === b;
}

interface ComboboxOptionData {
  id: string;
  ref: RefObject<HTMLElement | null>;
  readonly disabled: boolean;
  value: unknown;
  textValue: () => string;
  order?: number;
}

interface ComboboxState {
  open: boolean;
  openOptions: () => void;
  closeOptions: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  buttonRef: RefObject<HTMLElement | null>;
  optionsRef: RefObject<HTMLElement | null>;
  inputId: string;
  buttonId: string;
  optionsId: string;
  options: ComboboxOptionData[];
  registerOption: (option: ComboboxOptionData) => void;
  unregisterOption: (id: string) => void;
  activeOptionIndex: number | null;
  setActiveOptionIndex: (index: number | null | ((prev: number | null) => number | null)) => void;
  activationTrigger: ActivationTrigger;
  setActivationTrigger: (trigger: ActivationTrigger) => void;
  value: unknown;
  setValue: (value: unknown) => void;
  compare: (a: unknown, b: unknown) => boolean;
  multiple: boolean;
  disabled: boolean;
  immediate: boolean;
  onClose?: () => void;
}

const ComboboxContext = createContext<ComboboxState | null>(null);
ComboboxContext.displayName = 'ComboboxContext';

function useComboboxContext(component: string): ComboboxState {
  const ctx = useContext(ComboboxContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used within a <Combobox>`);
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

interface ComboboxProps<T> {
  as?: ElementType;
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  onClose?: () => void;
  by?: string | ((a: T, b: T) => boolean);
  disabled?: boolean;
  multiple?: boolean;
  immediate?: boolean;
  name?: string;
  form?: string;
  children?: unknown;
  [key: string]: unknown;
}

function ComboboxFn<T>({
  as: Tag = Fragment,
  value: controlledValue,
  defaultValue,
  onChange,
  onClose,
  by,
  disabled = false,
  multiple = false,
  immediate = false,
  name,
  form,
  children,
  ...rest
}: ComboboxProps<T>) {
  const defaultVal = multiple ? ([] as unknown as T) : defaultValue;
  const [value, setValueT] = useControllable<T>(controlledValue, onChange, defaultVal as T);
  const compare = resolveCompare<T>(by);

  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ComboboxOptionData[]>([]);
  const [activeOptionIndex, setActiveOptionIndex] = useState<number | null>(null);
  const [activationTrigger, setActivationTrigger] = useState<ActivationTrigger>(
    ActivationTrigger.Other
  );

  const inputId = useId();
  const buttonId = useId();
  const optionsId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const buttonRef = useRef<HTMLElement | null>(null);
  const optionsRef = useRef<HTMLElement | null>(null);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const openOptions = useCallback(() => setOpen(true), []);

  const closeOptions = useCallback(() => {
    setOpen(false);
    setActiveOptionIndex(null);
    onCloseRef.current?.();
  }, []);

  const registerOption = useCallback((option: ComboboxOptionData) => {
    setOptions((prev) => {
      if (prev.find((o) => o.id === option.id)) return prev;

      if (option.order !== undefined) {
        const next = [...prev, option];
        next.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        return next;
      }

      if (option.ref.current && optionsRef.current) {
        const allOptions = Array.from(
          optionsRef.current.querySelectorAll<HTMLElement>('[role="option"]')
        );
        const index = allOptions.indexOf(option.ref.current);
        if (index !== -1) {
          const next = [...prev];
          next.splice(index, 0, option);
          return next;
        }
      }
      return [...prev, option];
    });
  }, []);

  const unregisterOption = useCallback((id: string) => {
    setOptions((prev) => prev.filter((o) => o.id !== id));
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

  const ctx: ComboboxState = {
    open,
    openOptions,
    closeOptions,
    inputRef,
    buttonRef,
    optionsRef,
    inputId,
    buttonId,
    optionsId,
    options,
    registerOption,
    unregisterOption,
    activeOptionIndex,
    setActiveOptionIndex,
    activationTrigger,
    setActivationTrigger,
    value,
    setValue,
    compare: compareUnknown,
    multiple,
    disabled,
    immediate,
    onClose,
  };

  const activeOption =
    activeOptionIndex !== null && options[activeOptionIndex]
      ? options[activeOptionIndex].value
      : null;

  const slot = { open, disabled, value, activeOption, activeIndex: activeOptionIndex };

  let hiddenValue: string | string[] | undefined;
  if (name) {
    if (multiple && Array.isArray(value)) {
      hiddenValue = (value as unknown[]).map((v) =>
        v !== undefined && v !== null ? String(v) : ''
      );
    } else {
      hiddenValue = value !== undefined && value !== null ? String(value) : '';
    }
  }

  return createElement(
    ComboboxContext.Provider,
    { value: ctx },
    createElement(
      OpenClosedContext.Provider,
      { value: open ? State.Open : State.Closed },
      render({
        ourProps: {},
        theirProps: { as: Tag, children, ...rest },
        slot,
        defaultTag: Fragment,
        name: 'Combobox',
      })
    ),
    name ? createElement(Hidden, { name, value: hiddenValue, form }) : null
  );
}

ComboboxFn.displayName = 'Combobox';
const ComboboxWithName = ComboboxFn as typeof ComboboxFn & { displayName: string };
ComboboxWithName.displayName = 'Combobox';
export const Combobox = ComboboxWithName;

interface ComboboxInputProps<T> {
  as?: ElementType;
  displayValue?: (item: T) => string;
  onChange?: (event: Event) => void;
  autoFocus?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function ComboboxInputFn<T>({
  as: Tag = 'input',
  displayValue,
  onChange: userOnChange,
  autoFocus = false,
  children,
  ...rest
}: ComboboxInputProps<T>) {
  const {
    open,
    openOptions,
    closeOptions,
    inputRef,
    inputId,
    optionsId,
    options,
    activeOptionIndex,
    setActiveOptionIndex,
    setActivationTrigger,
    value,
    setValue,
    compare,
    multiple,
    disabled,
    immediate,
  } = useComboboxContext('ComboboxInput');

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    if (open) return;
    const input = inputRef.current;
    if (!input) return;
    if (!displayValue) return;
    if (value === undefined || value === null) {
      input.value = '';
      return;
    }
    if (multiple && Array.isArray(value)) return;
    input.value = displayValue(value as T);
  }, [open, value, displayValue, inputRef, multiple]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (disabled) return;

      const resolveItems = () =>
        options.map((opt) => ({
          id: opt.id,
          dataRef: { current: { disabled: opt.disabled } },
        }));
      const resolveActiveIndex = () => activeOptionIndex;
      const resolveId = (item: { id: string }) => item.id;
      const resolveDisabled = (item: { dataRef: { current: { disabled: boolean } } }) =>
        item.dataRef.current.disabled;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          if (!open) {
            openOptions();
            requestAnimationFrame(() => {
              setActiveOptionIndex(
                calculateActiveIndex(
                  { focus: Focus.First },
                  {
                    resolveItems,
                    resolveActiveIndex: () => null,
                    resolveId,
                    resolveDisabled,
                  }
                )
              );
              setActivationTrigger(ActivationTrigger.Other);
            });
          } else {
            setActiveOptionIndex(
              calculateActiveIndex(
                { focus: activeOptionIndex === null ? Focus.First : Focus.Next },
                { resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
              )
            );
            setActivationTrigger(ActivationTrigger.Other);
          }
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          if (!open) {
            openOptions();
            requestAnimationFrame(() => {
              setActiveOptionIndex(
                calculateActiveIndex(
                  { focus: Focus.Last },
                  {
                    resolveItems,
                    resolveActiveIndex: () => null,
                    resolveId,
                    resolveDisabled,
                  }
                )
              );
              setActivationTrigger(ActivationTrigger.Other);
            });
          } else {
            setActiveOptionIndex(
              calculateActiveIndex(
                { focus: activeOptionIndex === null ? Focus.Last : Focus.Previous },
                { resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
              )
            );
            setActivationTrigger(ActivationTrigger.Other);
          }
          break;
        }
        case 'Home':
        case 'PageUp': {
          e.preventDefault();
          if (open) {
            setActiveOptionIndex(
              calculateActiveIndex(
                { focus: Focus.First },
                { resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
              )
            );
            setActivationTrigger(ActivationTrigger.Other);
          }
          break;
        }
        case 'End':
        case 'PageDown': {
          e.preventDefault();
          if (open) {
            setActiveOptionIndex(
              calculateActiveIndex(
                { focus: Focus.Last },
                { resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
              )
            );
            setActivationTrigger(ActivationTrigger.Other);
          }
          break;
        }
        case 'Enter': {
          e.preventDefault();
          if (open && activeOptionIndex !== null) {
            const opt = options[activeOptionIndex];
            if (opt && !opt.disabled) {
              selectOption(opt.value);
            }
          }
          if (open) {
            closeOptions();
            const input = inputRef.current;
            if (input && displayValue && !multiple) {
              if (value !== undefined && value !== null) {
                input.value = displayValue(value as T);
              }
            }
          }
          break;
        }
        case 'Tab': {
          if (open && activeOptionIndex !== null) {
            const opt = options[activeOptionIndex];
            if (opt && !opt.disabled) {
              selectOption(opt.value);
            }
          }
          if (open) {
            closeOptions();
          }
          break;
        }
        case 'Escape': {
          e.preventDefault();
          if (open) {
            closeOptions();
            const input = inputRef.current;
            if (input && displayValue && !multiple) {
              if (value !== undefined && value !== null) {
                input.value = displayValue(value as T);
              }
            }
          } else {
            const input = inputRef.current;
            if (input) {
              input.value = '';
            }
          }
          break;
        }
        default:
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      disabled,
      open,
      openOptions,
      closeOptions,
      options,
      activeOptionIndex,
      setActiveOptionIndex,
      setActivationTrigger,
      value,
      displayValue,
      multiple,
      inputRef,
    ]
  );

  const selectOption = useCallback(
    (optionValue: unknown) => {
      if (multiple && Array.isArray(value)) {
        const arr = value as unknown[];
        const alreadySelected = arr.some((v) => compare(v, optionValue));
        if (alreadySelected) {
          setValue(arr.filter((v) => !compare(v, optionValue)));
        } else {
          setValue([...arr, optionValue]);
        }
      } else {
        setValue(optionValue);
      }
    },
    [multiple, value, compare, setValue]
  );

  const handleInput = useCallback(
    (e: Event) => {
      if (!open) {
        openOptions();
      }
      userOnChange?.(e);
    },
    [open, openOptions, userOnChange]
  );

  const handleFocus = useCallback(() => {
    setFocus(true);
    if (immediate && !open) {
      openOptions();
    }
  }, [immediate, open, openOptions]);

  const handleBlur = useCallback(() => {
    setFocus(false);
  }, []);

  const ourProps: Record<string, unknown> = {
    id: inputId,
    ref: inputRef,
    role: 'combobox',
    'aria-expanded': open,
    'aria-controls': optionsId,
    'aria-autocomplete': 'list',
    autoComplete: 'off',
    autoFocus,
    disabled: disabled || undefined,
    onInput: handleInput,
    onKeyDown: handleKeyDown,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: handleFocus,
    onBlur: handleBlur,
  };

  const slot = { open, disabled, hover, focus, autofocus: autoFocus };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'input',
    name: 'ComboboxInput',
  });
}

ComboboxInputFn.displayName = 'ComboboxInput';
const ComboboxInputWithName = ComboboxInputFn as typeof ComboboxInputFn & { displayName: string };
ComboboxInputWithName.displayName = 'ComboboxInput';
export const ComboboxInput = ComboboxInputWithName;

interface ComboboxButtonProps {
  as?: ElementType;
  disabled?: boolean;
  autoFocus?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function ComboboxButtonFn({
  as: Tag = 'button',
  disabled: individualDisabled = false,
  autoFocus = false,
  children,
  ...rest
}: ComboboxButtonProps) {
  const {
    open,
    openOptions,
    closeOptions,
    buttonRef,
    buttonId,
    inputId,
    optionsId,
    disabled: groupDisabled,
    value,
  } = useComboboxContext('ComboboxButton');

  const disabled = groupDisabled || individualDisabled;

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(false);

  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      if (open) {
        closeOptions();
      } else {
        openOptions();
      }
    },
    [disabled, open, openOptions, closeOptions]
  );

  const ourProps: Record<string, unknown> = {
    id: buttonId,
    ref: buttonRef,
    'aria-haspopup': 'listbox',
    'aria-expanded': open,
    'aria-controls': optionsId,
    'aria-labelledby': inputId,
    tabIndex: -1,
    autoFocus,
    disabled: disabled || undefined,
    onClick: handleClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    onMouseDown: () => setActive(true),
    onMouseUp: () => setActive(false),
  };

  const slot = { open, disabled, value, hover, focus, active, autofocus: autoFocus };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'button',
    name: 'ComboboxButton',
  });
}

ComboboxButtonFn.displayName = 'ComboboxButton';
const ComboboxButtonWithName = ComboboxButtonFn as typeof ComboboxButtonFn & {
  displayName: string;
};
ComboboxButtonWithName.displayName = 'ComboboxButton';
export const ComboboxButton = ComboboxButtonWithName;

interface ComboboxOptionsProps {
  as?: ElementType;
  transition?: boolean;
  static?: boolean;
  unmount?: boolean;
  anchor?: string;
  portal?: boolean;
  modal?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function ComboboxOptionsFn({
  as: Tag = 'div',
  transition = false,
  static: isStatic = false,
  unmount = true,
  anchor: _anchor,
  portal = false,
  modal: _modal = true,
  children,
  ...rest
}: ComboboxOptionsProps) {
  const {
    open,
    closeOptions,
    inputRef,
    buttonRef,
    optionsRef,
    inputId,
    optionsId,
    options,
    activeOptionIndex,
    multiple,
  } = useComboboxContext('ComboboxOptions');

  useOutsideClick(
    [inputRef as RefObject<HTMLElement | null>, buttonRef, optionsRef],
    useCallback(() => {
      closeOptions();
    }, [closeOptions]),
    open
  );

  const transitionAttrs = useTransitionAttrs(open, transition);

  const activeOptionId =
    activeOptionIndex !== null && options[activeOptionIndex]
      ? options[activeOptionIndex].id
      : undefined;

  const ourProps: Record<string, unknown> = {
    id: optionsId,
    ref: optionsRef,
    role: 'listbox',
    'aria-activedescendant': activeOptionId,
    'aria-labelledby': inputId,
    ...(multiple ? { 'aria-multiselectable': true } : {}),
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
    name: 'ComboboxOptions',
  });

  if (portal) {
    return createElement(Portal, { enabled: true, children: inner });
  }

  return inner;
}

ComboboxOptionsFn.displayName = 'ComboboxOptions';
const ComboboxOptionsWithName = ComboboxOptionsFn as typeof ComboboxOptionsFn & {
  displayName: string;
};
ComboboxOptionsWithName.displayName = 'ComboboxOptions';
export const ComboboxOptions = ComboboxOptionsWithName;

interface ComboboxOptionProps<T> {
  as?: ElementType;
  value: T;
  disabled?: boolean;
  order?: number;
  children?: unknown;
  [key: string]: unknown;
}

function ComboboxOptionFn<T>({
  as: Tag = 'div',
  value: optionValue,
  disabled = false,
  order,
  children,
  ...rest
}: ComboboxOptionProps<T>) {
  const {
    closeOptions,
    options,
    registerOption,
    unregisterOption,
    activeOptionIndex,
    setActiveOptionIndex,
    setActivationTrigger,
    value,
    setValue,
    compare,
    multiple,
  } = useComboboxContext('ComboboxOption');

  const id = useId();
  const ref = useRef<HTMLElement | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const getTextValue = useTextValue(ref);
  const pointer = useTrackedPointer();

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

  const activeOption = activeOptionIndex !== null ? options[activeOptionIndex] : null;
  const isActive = activeOption ? activeOption.id === id : false;

  const isSelected = (() => {
    if (multiple && Array.isArray(value)) {
      return (value as unknown[]).some((v) => compare(v, optionValue));
    }
    if (value === undefined || value === null) return false;
    return compare(value, optionValue);
  })();

  useEffect(() => {
    const optionData: ComboboxOptionData = {
      id,
      ref,
      get disabled() {
        return disabledRef.current;
      },
      value: optionValue,
      textValue: getTextValue,
      order,
    };
    registerOption(optionData);
    return () => unregisterOption(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (disabled) {
        e.preventDefault();
        return;
      }

      if (multiple && Array.isArray(value)) {
        const arr = value as unknown[];
        const alreadySelected = arr.some((v) => compare(v, optionValue));
        if (alreadySelected) {
          setValue(arr.filter((v) => !compare(v, optionValue)));
        } else {
          setValue([...arr, optionValue]);
        }
      } else {
        setValue(optionValue);
        closeOptions();
      }
    },
    [disabled, multiple, value, compare, optionValue, setValue, closeOptions]
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      pointer.update(e);
      if (!pointer.wasMoved(e)) return;
      if (disabled) return;
      setHover(true);
      setActiveOptionIndex((currentIndex) => {
        const idx = options.findIndex((opt) => opt.id === id);
        if (idx === -1) return currentIndex;
        return idx;
      });
      setActivationTrigger(ActivationTrigger.Pointer);
    },
    [disabled, id, options, pointer, setActiveOptionIndex, setActivationTrigger]
  );

  const handlePointerLeave = useCallback(
    (e: PointerEvent) => {
      pointer.update(e);
      setHover(false);
      setActiveOptionIndex((currentIndex) => {
        const idx = options.findIndex((opt) => opt.id === id);
        if (idx !== -1 && currentIndex === idx) return null;
        return currentIndex;
      });
    },
    [id, options, pointer, setActiveOptionIndex]
  );

  const ourProps: Record<string, unknown> = {
    id,
    ref,
    role: 'option',
    tabIndex: -1,
    'aria-selected': isSelected,
    'aria-disabled': disabled || undefined,
    onClick: handleClick,
    onPointerMove: handlePointerMove,
    onPointerLeave: handlePointerLeave,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
  };

  const slot = {
    selected: isSelected,
    active: isActive,
    disabled,
    hover,
    focus,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'div',
    name: 'ComboboxOption',
  });
}

ComboboxOptionFn.displayName = 'ComboboxOption';
const ComboboxOptionWithName = ComboboxOptionFn as typeof ComboboxOptionFn & {
  displayName: string;
};
ComboboxOptionWithName.displayName = 'ComboboxOption';
export const ComboboxOption = ComboboxOptionWithName;
