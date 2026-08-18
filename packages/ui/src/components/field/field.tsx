import { createContext, createElement } from 'preact';
import { useCallback, useContext, useEffect, useState } from 'preact/hooks';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { useId } from '../../internal/use-id.ts';

interface FieldsetContextValue {
  disabled: boolean;
}

const FieldsetContext = createContext<FieldsetContextValue | null>(null);
FieldsetContext.displayName = 'FieldsetContext';

interface FieldContextValue {
  disabled: boolean;
  labelId: string | null;
  setLabelId: (id: string | null) => void;
  descriptionIds: string[];
  addDescriptionId: (id: string) => void;
  removeDescriptionId: (id: string) => void;
  controlId: string | null;
  setControlId: (id: string | null) => void;
  invalidCount: number;
  incrementInvalid: () => void;
  decrementInvalid: () => void;
}

const FieldContext = createContext<FieldContextValue | null>(null);
FieldContext.displayName = 'FieldContext';

export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext);
}

export function useFieldsetContext(): FieldsetContextValue | null {
  return useContext(FieldsetContext);
}

interface FieldsetProps {
  as?: ElementType;
  disabled?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function FieldsetFn({ as: Tag = 'fieldset', disabled = false, children, ...rest }: FieldsetProps) {
  const parentFieldset = useContext(FieldsetContext);
  const isDisabled = disabled || (parentFieldset?.disabled ?? false);

  const ctx: FieldsetContextValue = { disabled: isDisabled };

  const slot = { disabled: isDisabled };

  const ourProps: Record<string, unknown> = {
    disabled: isDisabled || undefined,
  };

  return createElement(
    FieldsetContext.Provider,
    { value: ctx },
    render({
      ourProps,
      theirProps: { as: Tag, children, ...rest },
      slot,
      defaultTag: 'fieldset',
      name: 'Fieldset',
    })
  );
}

FieldsetFn.displayName = 'Fieldset';
export const Fieldset = FieldsetFn;

interface FieldProps {
  as?: ElementType;
  disabled?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function FieldFn({ as: Tag = 'div', disabled = false, children, ...rest }: FieldProps) {
  const fieldsetCtx = useContext(FieldsetContext);
  const isDisabled = disabled || (fieldsetCtx?.disabled ?? false);

  const [labelId, setLabelId] = useState<string | null>(null);
  const [descriptionIds, setDescriptionIds] = useState<string[]>([]);
  const [controlId, setControlId] = useState<string | null>(null);
  const [invalidCount, setInvalidCount] = useState(0);

  const stableLabelId = useCallback((id: string | null) => setLabelId(id), []);
  const stableControlId = useCallback((id: string | null) => setControlId(id), []);
  const stableAddDescriptionId = useCallback((id: string) => {
    setDescriptionIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);
  const stableRemoveDescriptionId = useCallback((id: string) => {
    setDescriptionIds((prev) => prev.filter((existingId) => existingId !== id));
  }, []);
  const stableIncrementInvalid = useCallback(() => {
    setInvalidCount((prev) => prev + 1);
  }, []);
  const stableDecrementInvalid = useCallback(() => {
    setInvalidCount((prev) => Math.max(0, prev - 1));
  }, []);

  const ctx: FieldContextValue = {
    disabled: isDisabled,
    labelId,
    setLabelId: stableLabelId,
    descriptionIds,
    addDescriptionId: stableAddDescriptionId,
    removeDescriptionId: stableRemoveDescriptionId,
    controlId,
    setControlId: stableControlId,
    invalidCount,
    incrementInvalid: stableIncrementInvalid,
    decrementInvalid: stableDecrementInvalid,
  };

  const slot = { disabled: isDisabled };

  const ourProps: Record<string, unknown> = {};

  return createElement(
    FieldContext.Provider,
    { value: ctx },
    render({
      ourProps,
      theirProps: { as: Tag, children, ...rest },
      slot,
      defaultTag: 'div',
      name: 'Field',
    })
  );
}

FieldFn.displayName = 'Field';
export const Field = FieldFn;

interface LegendProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function LegendFn({ as: Tag = 'legend', children, ...rest }: LegendProps) {
  return render({
    ourProps: {},
    theirProps: { as: Tag, children, ...rest },
    slot: {},
    defaultTag: 'legend',
    name: 'Legend',
  });
}

LegendFn.displayName = 'Legend';
export const Legend = LegendFn;

interface LabelProps {
  as?: ElementType;
  passive?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function LabelFn({ as: Tag = 'label', passive = false, children, ...rest }: LabelProps) {
  const fieldCtx = useContext(FieldContext);
  const fieldsetCtx = useContext(FieldsetContext);

  const isDisabled = fieldCtx?.disabled ?? fieldsetCtx?.disabled ?? false;

  const id = useId();

  useEffect(() => {
    if (!fieldCtx) return;
    fieldCtx.setLabelId(id);
    return () => {
      fieldCtx.setLabelId(null);
    };
  }, [id, fieldCtx]);

  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (passive) {
        e.preventDefault();
        return;
      }
      if (fieldCtx?.controlId) {
        const el = document.getElementById(fieldCtx.controlId);
        if (el) {
          el.focus();
        }
      }
    },
    [passive, fieldCtx]
  );

  const slot = { disabled: isDisabled };

  const ourProps: Record<string, unknown> = {
    id,
    htmlFor: !passive && fieldCtx?.controlId ? fieldCtx.controlId : undefined,
    onClick: handleClick,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'label',
    name: 'Label',
  });
}

LabelFn.displayName = 'Label';
export const Label = LabelFn;

interface DescriptionProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function DescriptionFn({ as: Tag = 'p', children, ...rest }: DescriptionProps) {
  const fieldCtx = useContext(FieldContext);
  const fieldsetCtx = useContext(FieldsetContext);

  const isDisabled = fieldCtx?.disabled ?? fieldsetCtx?.disabled ?? false;

  const id = useId();

  useEffect(() => {
    if (!fieldCtx) return;
    fieldCtx.addDescriptionId(id);
    return () => {
      fieldCtx.removeDescriptionId(id);
    };
  }, [id, fieldCtx]);

  const slot = { disabled: isDisabled };

  const ourProps: Record<string, unknown> = {
    id,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'p',
    name: 'Description',
  });
}

DescriptionFn.displayName = 'Description';
export const Description = DescriptionFn;

interface FieldErrorProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function FieldErrorFn({ as: Tag = 'p', children, ...rest }: FieldErrorProps) {
  const fieldCtx = useContext(FieldContext);
  const fieldsetCtx = useContext(FieldsetContext);

  const isDisabled = fieldCtx?.disabled ?? fieldsetCtx?.disabled ?? false;

  const id = useId();

  useEffect(() => {
    if (!fieldCtx) return;
    fieldCtx.incrementInvalid();
    fieldCtx.addDescriptionId(id);
    return () => {
      fieldCtx.decrementInvalid();
      fieldCtx.removeDescriptionId(id);
    };
  }, [id, fieldCtx]);

  const slot = { disabled: isDisabled };

  const ourProps: Record<string, unknown> = {
    id,
    role: 'alert',
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'p',
    name: 'FieldError',
  });
}

FieldErrorFn.displayName = 'FieldError';
export const FieldError = FieldErrorFn;
