import type { RefObject, VNode } from 'preact';
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
import { useEscape } from '../../internal/use-escape.ts';
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

interface ListboxOptionData {
  id: string;
  ref: RefObject<HTMLElement | null>;
  readonly disabled: boolean;
  value: unknown;
  textValue: () => string;
}

interface ListboxState {
  open: boolean;
  toggle: () => void;
  close: () => void;
  buttonRef: RefObject<HTMLElement | null>;
  optionsRef: RefObject<HTMLElement | null>;
  buttonId: string;
  optionsId: string;
  options: ListboxOptionData[];
  registerOption: (option: ListboxOptionData) => void;
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
  invalid: boolean;
  horizontal: boolean;
}

const ListboxContext = createContext<ListboxState | null>(null);
ListboxContext.displayName = 'ListboxContext';

function useListboxContext(component: string): ListboxState {
  const ctx = useContext(ListboxContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used within a <Listbox>`);
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

interface ListboxProps<T> {
  as?: ElementType;
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  by?: string | ((a: T, b: T) => boolean);
  disabled?: boolean;
  invalid?: boolean;
  horizontal?: boolean;
  multiple?: boolean;
  name?: string;
  form?: string;
  children?: unknown;
  [key: string]: unknown;
}

function ListboxFn<T>({
  as: Tag = Fragment,
  value: controlledValue,
  defaultValue,
  onChange,
  by,
  disabled = false,
  invalid = false,
  horizontal = false,
  multiple = false,
  name,
  form,
  children,
  ...rest
}: ListboxProps<T>) {
  const defaultVal = multiple ? ([] as unknown as T) : defaultValue;
  const [value, setValueT] = useControllable<T>(controlledValue, onChange, defaultVal as T);
  const compare = resolveCompare<T>(by);

  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ListboxOptionData[]>([]);
  const [activeOptionIndex, setActiveOptionIndex] = useState<number | null>(null);
  const [activationTrigger, setActivationTrigger] = useState<ActivationTrigger>(
    ActivationTrigger.Other
  );

  const buttonId = useId();
  const optionsId = useId();
  const buttonRef = useRef<HTMLElement | null>(null);
  const optionsRef = useRef<HTMLElement | null>(null);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  const close = useCallback(() => {
    setOpen(false);
    setActiveOptionIndex(null);
  }, []);

  const registerOption = useCallback((option: ListboxOptionData) => {
    setOptions((prev) => {
      if (prev.find((o) => o.id === option.id)) return prev;
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

  const ctx: ListboxState = {
    open,
    toggle,
    close,
    buttonRef,
    optionsRef,
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
    invalid,
    horizontal,
  };

  const slot = { open, disabled, invalid, value };

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
    ListboxContext.Provider,
    { value: ctx },
    createElement(
      OpenClosedContext.Provider,
      { value: open ? State.Open : State.Closed },
      render({
        ourProps: {},
        theirProps: { as: Tag, children, ...rest },
        slot,
        defaultTag: Fragment,
        name: 'Listbox',
      })
    ),
    name ? createElement(Hidden, { name, value: hiddenValue, form }) : null
  );
}

ListboxFn.displayName = 'Listbox';
const ListboxWithName = ListboxFn as typeof ListboxFn & { displayName: string };
ListboxWithName.displayName = 'Listbox';
export const Listbox = ListboxWithName;

interface ListboxButtonProps {
  as?: ElementType;
  disabled?: boolean;
  autoFocus?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function ListboxButtonFn({
  as: Tag = 'button',
  disabled: individualDisabled = false,
  autoFocus = false,
  children,
  ...rest
}: ListboxButtonProps) {
  const {
    open,
    toggle,
    close,
    buttonRef,
    buttonId,
    optionsId,
    optionsRef,
    disabled: groupDisabled,
    invalid,
    value,
  } = useListboxContext('ListboxButton');

  const disabled = groupDisabled || individualDisabled;

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(false);

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
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!open) {
          toggle();
        }
        requestAnimationFrame(() => {
          const el = optionsRef.current;
          if (el) {
            el.focus();
            el.dispatchEvent(
              new CustomEvent('listbox:openkey', {
                detail: { key: e.key === 'ArrowUp' ? 'ArrowUp' : 'ArrowDown' },
                bubbles: false,
              })
            );
          }
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) {
          toggle();
        }
        requestAnimationFrame(() => {
          const el = optionsRef.current;
          if (el) {
            el.focus();
            el.dispatchEvent(
              new CustomEvent('listbox:openkey', {
                detail: { key: 'ArrowUp' },
                bubbles: false,
              })
            );
          }
        });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
        requestAnimationFrame(() => {
          buttonRef.current?.focus();
        });
      }
    },
    [disabled, open, toggle, close, optionsRef, buttonRef]
  );

  const ourProps: Record<string, unknown> = {
    id: buttonId,
    ref: buttonRef,
    'aria-haspopup': 'listbox',
    'aria-expanded': open,
    'aria-controls': optionsId,
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

  const slot = { open, disabled, invalid, value, hover, focus, active, autofocus: autoFocus };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'button',
    name: 'ListboxButton',
  });
}

ListboxButtonFn.displayName = 'ListboxButton';
export const ListboxButton = ListboxButtonFn;

interface ListboxOptionsProps {
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

function ListboxOptionsFn({
  as: Tag = 'div',
  transition = false,
  static: isStatic = false,
  unmount = true,
  anchor: _anchor,
  portal = false,
  modal: _modal = true,
  children,
  ...rest
}: ListboxOptionsProps) {
  const {
    open,
    close,
    buttonRef,
    optionsRef,
    buttonId,
    optionsId,
    options,
    activeOptionIndex,
    setActiveOptionIndex,
    setActivationTrigger,
    horizontal,
    multiple,
  } = useListboxContext('ListboxOptions');

  const searchBufferRef = useRef('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useOutsideClick(
    [buttonRef, optionsRef],
    useCallback(() => {
      close();
    }, [close]),
    open
  );

  useEscape(
    useCallback(
      (e: KeyboardEvent) => {
        e.preventDefault();
        close();
        requestAnimationFrame(() => {
          buttonRef.current?.focus();
        });
      },
      [close, buttonRef]
    ),
    open
  );

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        optionsRef.current?.focus();
      });
    } else {
      setActiveOptionIndex(null);
    }
  }, [open, optionsRef, setActiveOptionIndex]);

  useEffect(() => {
    const el = optionsRef.current;
    if (!el) return;

    function handleOpenKey(e: Event) {
      const key = (e as CustomEvent<{ key: string }>).detail.key;
      const resolverArgs = {
        resolveItems: () =>
          options.map((opt) => ({
            id: opt.id,
            dataRef: { current: { disabled: opt.disabled } },
          })),
        resolveActiveIndex: () => null,
        resolveId: (item: { id: string }) => item.id,
        resolveDisabled: (item: { dataRef: { current: { disabled: boolean } } }) =>
          item.dataRef.current.disabled,
      };

      if (key === 'ArrowUp') {
        setActiveOptionIndex(calculateActiveIndex({ focus: Focus.Last }, resolverArgs));
      } else {
        setActiveOptionIndex(calculateActiveIndex({ focus: Focus.First }, resolverArgs));
      }
      setActivationTrigger(ActivationTrigger.Other);
    }

    el.addEventListener('listbox:openkey', handleOpenKey);
    return () => el.removeEventListener('listbox:openkey', handleOpenKey);
  }, [options, setActiveOptionIndex, setActivationTrigger, optionsRef]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const resolveItems = () =>
        options.map((opt) => ({
          id: opt.id,
          dataRef: { current: { disabled: opt.disabled } },
        }));
      const resolveActiveIndex = () => activeOptionIndex;
      const resolveId = (item: { id: string }) => item.id;
      const resolveDisabled = (item: { dataRef: { current: { disabled: boolean } } }) =>
        item.dataRef.current.disabled;

      const prevKey = horizontal ? 'ArrowLeft' : 'ArrowUp';
      const nextKey = horizontal ? 'ArrowRight' : 'ArrowDown';

      switch (e.key) {
        case nextKey: {
          e.preventDefault();
          setActiveOptionIndex(
            calculateActiveIndex(
              { focus: activeOptionIndex === null ? Focus.First : Focus.Next },
              { resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
            )
          );
          setActivationTrigger(ActivationTrigger.Other);
          break;
        }
        case prevKey: {
          e.preventDefault();
          setActiveOptionIndex(
            calculateActiveIndex(
              { focus: activeOptionIndex === null ? Focus.Last : Focus.Previous },
              { resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
            )
          );
          setActivationTrigger(ActivationTrigger.Other);
          break;
        }
        case 'Home':
        case 'PageUp': {
          e.preventDefault();
          setActiveOptionIndex(
            calculateActiveIndex(
              { focus: Focus.First },
              { resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
            )
          );
          setActivationTrigger(ActivationTrigger.Other);
          break;
        }
        case 'End':
        case 'PageDown': {
          e.preventDefault();
          setActiveOptionIndex(
            calculateActiveIndex(
              { focus: Focus.Last },
              { resolveItems, resolveActiveIndex, resolveId, resolveDisabled }
            )
          );
          setActivationTrigger(ActivationTrigger.Other);
          break;
        }
        case 'Enter':
        case ' ': {
          e.preventDefault();
          if (activeOptionIndex !== null) {
            const opt = options[activeOptionIndex];
            if (opt && !opt.disabled) {
              opt.ref.current?.click();
            }
          }
          if (!multiple) {
            close();
            requestAnimationFrame(() => {
              buttonRef.current?.focus();
            });
          }
          break;
        }
        case 'Tab': {
          e.preventDefault();
          close();
          break;
        }
        case 'Escape': {
          e.preventDefault();
          break;
        }
        default: {
          if (e.key.length === 1 && e.key.match(/\S/)) {
            e.preventDefault();
            searchBufferRef.current += e.key.toLowerCase();
            if (searchTimerRef.current !== null) {
              clearTimeout(searchTimerRef.current);
            }
            searchTimerRef.current = setTimeout(() => {
              searchBufferRef.current = '';
              searchTimerRef.current = null;
            }, 350);

            const query = searchBufferRef.current;
            const matchIndex = options.findIndex((opt, index) => {
              if (opt.disabled) return false;
              if (activeOptionIndex !== null && index <= activeOptionIndex) return false;
              return opt.textValue().startsWith(query);
            });

            if (matchIndex !== -1) {
              setActiveOptionIndex(matchIndex);
              setActivationTrigger(ActivationTrigger.Other);
            } else {
              const wrapIndex = options.findIndex((opt) => {
                if (opt.disabled) return false;
                return opt.textValue().startsWith(query);
              });
              if (wrapIndex !== -1) {
                setActiveOptionIndex(wrapIndex);
                setActivationTrigger(ActivationTrigger.Other);
              }
            }
          }
          break;
        }
      }
    },
    [
      options,
      activeOptionIndex,
      setActiveOptionIndex,
      setActivationTrigger,
      close,
      buttonRef,
      multiple,
      horizontal,
    ]
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
    'aria-labelledby': buttonId,
    ...(multiple ? { 'aria-multiselectable': true } : {}),
    tabIndex: 0,
    onKeyDown: handleKeyDown,
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
    name: 'ListboxOptions',
  });

  if (portal) {
    return createElement(Portal, { enabled: true, children: inner });
  }

  return inner;
}

ListboxOptionsFn.displayName = 'ListboxOptions';
export const ListboxOptions = ListboxOptionsFn;

interface ListboxOptionProps<T> {
  as?: ElementType;
  value: T;
  disabled?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function ListboxOptionFn<T>({
  as: Tag = 'div',
  value: optionValue,
  disabled = false,
  children,
  ...rest
}: ListboxOptionProps<T>) {
  const {
    close,
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
  } = useListboxContext('ListboxOption');

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
    const optionData: ListboxOptionData = {
      id,
      ref,
      get disabled() {
        return disabledRef.current;
      },
      value: optionValue,
      textValue: getTextValue,
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
        close();
      }
    },
    [disabled, multiple, value, compare, optionValue, setValue, close]
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
    name: 'ListboxOption',
  });
}

ListboxOptionFn.displayName = 'ListboxOption';
const ListboxOptionWithName = ListboxOptionFn as typeof ListboxOptionFn & { displayName: string };
ListboxOptionWithName.displayName = 'ListboxOption';
export const ListboxOption = ListboxOptionWithName;

interface ListboxSelectedOptionProps {
  as?: ElementType;
  options?: VNode;
  placeholder?: VNode;
  children?: unknown;
  [key: string]: unknown;
}

function ListboxSelectedOptionFn({
  as: Tag = 'span',
  options: _options,
  placeholder,
  children,
  ...rest
}: ListboxSelectedOptionProps) {
  const { value } = useListboxContext('ListboxSelectedOption');

  const hasValue =
    value !== undefined &&
    value !== null &&
    !(Array.isArray(value) && (value as unknown[]).length === 0);

  const slot = { value };

  const resolvedChildren = hasValue ? children : (placeholder ?? children);

  return render({
    ourProps: {},
    theirProps: { as: Tag, children: resolvedChildren, ...rest },
    slot,
    defaultTag: 'span',
    name: 'ListboxSelectedOption',
  });
}

ListboxSelectedOptionFn.displayName = 'ListboxSelectedOption';
export const ListboxSelectedOption = ListboxSelectedOptionFn;
