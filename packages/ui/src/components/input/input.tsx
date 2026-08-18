import { useEffect, useState } from 'preact/hooks';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { useId } from '../../internal/use-id.ts';
import { useFieldContext, useFieldsetContext } from '../field/field.tsx';

interface InputProps {
  as?: ElementType;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function InputFn({
  as: Tag = 'input',
  invalid = false,
  disabled: ownDisabled = false,
  autoFocus = false,
  children,
  ...rest
}: InputProps) {
  const fieldCtx = useFieldContext();
  const fieldsetCtx = useFieldsetContext();

  const isDisabled = ownDisabled || (fieldCtx?.disabled ?? fieldsetCtx?.disabled ?? false);

  const id = useId();

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    if (!fieldCtx) return;
    fieldCtx.setControlId(id);
    return () => {
      fieldCtx.setControlId(null);
    };
  }, [id, fieldCtx]);

  const isInvalid = invalid || (fieldCtx?.invalidCount ?? 0) > 0;

  const slot = {
    disabled: isDisabled,
    invalid: isInvalid,
    hover,
    focus,
    autofocus: autoFocus,
  };

  const ourProps: Record<string, unknown> = {
    id,
    disabled: isDisabled || undefined,
    'aria-labelledby': fieldCtx?.labelId ?? undefined,
    'aria-describedby':
      fieldCtx?.descriptionIds && fieldCtx.descriptionIds.length > 0
        ? fieldCtx.descriptionIds.join(' ')
        : undefined,
    'aria-invalid': isInvalid || undefined,
    autoFocus: autoFocus || undefined,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'input',
    name: 'Input',
  });
}

InputFn.displayName = 'Input';
export const Input = InputFn;

interface TextareaProps {
  as?: ElementType;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function TextareaFn({
  as: Tag = 'textarea',
  invalid = false,
  disabled: ownDisabled = false,
  autoFocus = false,
  children,
  ...rest
}: TextareaProps) {
  const fieldCtx = useFieldContext();
  const fieldsetCtx = useFieldsetContext();

  const isDisabled = ownDisabled || (fieldCtx?.disabled ?? fieldsetCtx?.disabled ?? false);

  const id = useId();

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    if (!fieldCtx) return;
    fieldCtx.setControlId(id);
    return () => {
      fieldCtx.setControlId(null);
    };
  }, [id, fieldCtx]);

  const isInvalid = invalid || (fieldCtx?.invalidCount ?? 0) > 0;

  const slot = {
    disabled: isDisabled,
    invalid: isInvalid,
    hover,
    focus,
    autofocus: autoFocus,
  };

  const ourProps: Record<string, unknown> = {
    id,
    disabled: isDisabled || undefined,
    'aria-labelledby': fieldCtx?.labelId ?? undefined,
    'aria-describedby':
      fieldCtx?.descriptionIds && fieldCtx.descriptionIds.length > 0
        ? fieldCtx.descriptionIds.join(' ')
        : undefined,
    'aria-invalid': isInvalid || undefined,
    autoFocus: autoFocus || undefined,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'textarea',
    name: 'Textarea',
  });
}

TextareaFn.displayName = 'Textarea';
export const Textarea = TextareaFn;

interface SelectProps {
  as?: ElementType;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function SelectFn({
  as: Tag = 'select',
  invalid = false,
  disabled: ownDisabled = false,
  autoFocus = false,
  children,
  ...rest
}: SelectProps) {
  const fieldCtx = useFieldContext();
  const fieldsetCtx = useFieldsetContext();

  const isDisabled = ownDisabled || (fieldCtx?.disabled ?? fieldsetCtx?.disabled ?? false);

  const id = useId();

  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    if (!fieldCtx) return;
    fieldCtx.setControlId(id);
    return () => {
      fieldCtx.setControlId(null);
    };
  }, [id, fieldCtx]);

  const isInvalid = invalid || (fieldCtx?.invalidCount ?? 0) > 0;

  const slot = {
    disabled: isDisabled,
    invalid: isInvalid,
    hover,
    focus,
    autofocus: autoFocus,
  };

  const ourProps: Record<string, unknown> = {
    id,
    disabled: isDisabled || undefined,
    'aria-labelledby': fieldCtx?.labelId ?? undefined,
    'aria-describedby':
      fieldCtx?.descriptionIds && fieldCtx.descriptionIds.length > 0
        ? fieldCtx.descriptionIds.join(' ')
        : undefined,
    'aria-invalid': isInvalid || undefined,
    autoFocus: autoFocus || undefined,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'select',
    name: 'Select',
  });
}

SelectFn.displayName = 'Select';
export const Select = SelectFn;
