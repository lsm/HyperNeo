import { createContext, createElement } from 'preact';
import { useContext } from 'preact/hooks';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';

interface StepperContextValue {
  currentStep: number;
  orientation: 'horizontal' | 'vertical';
}

const StepperContext = createContext<StepperContextValue | null>(null);
StepperContext.displayName = 'StepperContext';

function useStepperContext(componentName: string): StepperContextValue {
  const ctx = useContext(StepperContext);
  if (ctx === null) {
    throw new Error(`<${componentName}> must be used within a <Stepper>`);
  }
  return ctx;
}

interface StepperProps {
  currentStep: number;
  orientation?: 'horizontal' | 'vertical';
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function StepperFn({
  currentStep,
  orientation = 'horizontal',
  as: Tag = 'div',
  children,
  ...rest
}: StepperProps) {
  const ctx: StepperContextValue = { currentStep, orientation };

  const slot = { currentStep, orientation };

  const ourProps: Record<string, unknown> = {
    role: 'list',
    'data-orientation': orientation,
  };

  return createElement(
    StepperContext.Provider,
    { value: ctx },
    render({
      ourProps,
      theirProps: { as: Tag, children, ...rest },
      slot,
      defaultTag: 'div',
      name: 'Stepper',
    })
  );
}

StepperFn.displayName = 'Stepper';
export const Stepper = StepperFn;

type StepStatus = 'complete' | 'current' | 'upcoming';

interface StepperStepProps {
  status: StepStatus;
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function StepperStepFn({ status, as: Tag = 'div', children, ...rest }: StepperStepProps) {
  const { currentStep, orientation } = useStepperContext('StepperStep');

  const slot = { status, currentStep, orientation };

  const ourProps: Record<string, unknown> = {
    role: 'listitem',
    'aria-current': status === 'current' ? 'step' : undefined,
    'data-status': status,
    'data-orientation': orientation,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'div',
    name: 'StepperStep',
  });
}

StepperStepFn.displayName = 'StepperStep';
export const StepperStep = StepperStepFn;

interface StepperIconProps {
  stepIndex: number;
  status?: StepStatus;
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function StepperIconFn({
  stepIndex,
  status = 'upcoming',
  as: Tag = 'span',
  children,
  ...rest
}: StepperIconProps) {
  const slot = { status, stepIndex };

  const checkmarkSvg = createElement('svg', {
    'aria-hidden': 'true',
    viewBox: '0 0 20 20',
    fill: 'currentColor',
    children: createElement('path', {
      'fill-rule': 'evenodd',
      d: 'M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z',
      'clip-rule': 'evenodd',
    }),
  });

  const numberContent = String(stepIndex + 1);

  const iconContent =
    children ??
    (status === 'complete'
      ? checkmarkSvg
      : createElement('span', { 'data-step-number': true }, numberContent));

  const ourProps: Record<string, unknown> = {
    'data-status': status,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children: iconContent, ...rest },
    slot,
    defaultTag: 'span',
    name: 'StepperIcon',
  });
}

StepperIconFn.displayName = 'StepperIcon';
export const StepperIcon = StepperIconFn;

interface StepperLabelProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function StepperLabelFn({ as: Tag = 'span', children, ...rest }: StepperLabelProps) {
  const slot = {};

  const ourProps: Record<string, unknown> = {};

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'span',
    name: 'StepperLabel',
  });
}

StepperLabelFn.displayName = 'StepperLabel';
export const StepperLabel = StepperLabelFn;

interface StepperDescriptionProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function StepperDescriptionFn({ as: Tag = 'span', children, ...rest }: StepperDescriptionProps) {
  const slot = {};

  const ourProps: Record<string, unknown> = {};

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'span',
    name: 'StepperDescription',
  });
}

StepperDescriptionFn.displayName = 'StepperDescription';
export const StepperDescription = StepperDescriptionFn;

interface StepperSeparatorProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function StepperSeparatorFn({ as: Tag = 'div', children, ...rest }: StepperSeparatorProps) {
  const { orientation } = useStepperContext('StepperSeparator');

  const slot = { orientation };

  const ourProps: Record<string, unknown> = {
    'data-orientation': orientation,
    'data-separator': true,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'div',
    name: 'StepperSeparator',
  });
}

StepperSeparatorFn.displayName = 'StepperSeparator';
export const StepperSeparator = StepperSeparatorFn;
