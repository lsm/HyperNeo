import { type ComponentChildren, createElement, Fragment, type Ref, type VNode } from 'preact';
import { type ElementType, Features, RenderStrategy } from './types.ts';

// Merge slot props data attributes into the element
// Generates data-headlessui-state attribute with space-separated state names
// and individual data-* attributes for each truthy boolean value
function mergeDataAttributes(slot: Record<string, unknown>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};

  // Check if slot has any boolean values
  let hasBooleanState = false;
  const truthyStates: string[] = [];

  for (const [key, value] of Object.entries(slot)) {
    if (typeof value === 'boolean') {
      hasBooleanState = true;
      // Convert camelCase to kebab-case (e.g., focusVisible -> focus-visible)
      const kebabKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      if (value) {
        truthyStates.push(kebabKey);
      }
    }
  }

  // Only add data-headlessui-state if there are boolean states in the slot
  if (hasBooleanState) {
    result['data-headlessui-state'] = truthyStates.length > 0 ? truthyStates.join(' ') : '';
    // Add individual data-* attributes for each truthy state
    for (const state of truthyStates) {
      result[`data-${state}`] = '';
    }
  }

  return result;
}

// Compact: remove undefined data attributes from props
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result = {} as Partial<T>;
  for (const key in obj) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

export function render<TSlot extends Record<string, unknown>>({
  ourProps,
  theirProps,
  slot,
  defaultTag,
  features,
  visible = true,
  name,
}: {
  ourProps: Record<string, unknown>;
  theirProps: Record<string, unknown>;
  slot: TSlot;
  defaultTag: ElementType;
  features?: Features;
  visible?: boolean;
  name: string;
}): VNode | null {
  // Merge props — our props take precedence
  const props = mergeProps(theirProps, ourProps);

  // Handle visibility
  if (!visible) {
    if (features !== undefined && features & Features.Static) {
      const { static: isStatic = false, ...rest } = props as Record<string, unknown> & {
        static?: boolean;
      };
      if (isStatic) {
        // Render as static (hidden but present in DOM)
        return renderElement(
          defaultTag,
          { ...rest, hidden: true, style: { display: 'none' } },
          slot,
          name
        );
      }
    }

    if (features !== undefined && features & Features.RenderStrategy) {
      const { unmount = true, ...rest } = props as Record<string, unknown> & { unmount?: boolean };
      const strategy = unmount ? RenderStrategy.Unmount : RenderStrategy.Hidden;

      if (strategy === RenderStrategy.Unmount) {
        return null;
      }

      return renderElement(
        defaultTag,
        { ...rest, hidden: true, style: { display: 'none' } },
        slot,
        name
      );
    }

    return null;
  }

  // Remove internal props before rendering
  const {
    static: _static,
    unmount: _unmount,
    ...cleanProps
  } = props as Record<string, unknown> & {
    static?: boolean;
    unmount?: boolean;
  };

  void _static;
  void _unmount;

  return renderElement(defaultTag, cleanProps, slot, name);
}

function renderElement<TSlot extends Record<string, unknown>>(
  tag: ElementType,
  props: Record<string, unknown>,
  slot: TSlot,
  _name: string
): VNode {
  const {
    as: Component = tag,
    children,
    ref,
    ...rest
  } = props as Record<string, unknown> & {
    as?: ElementType;
    children?: ComponentChildren | ((slot: TSlot) => ComponentChildren);
    ref?: Ref<unknown>;
  };

  // Resolve children (supports render prop pattern)
  const resolvedChildren = typeof children === 'function' ? children(slot) : children;

  // Add data attributes from slot
  const dataAttrs = mergeDataAttributes(slot);
  const finalProps = compact({ ...rest, ...dataAttrs, ref });

  // If Fragment, only pass children
  if (Component === Fragment) {
    // Fragment can't take props besides children and key
    if (Object.keys(finalProps).length > 0) {
      // If there are extra props with Fragment, wrap in span
      const { key: _key, ...nonKeyProps } = finalProps as Record<string, unknown> & {
        key?: string;
      };
      void _key;
      if (Object.keys(nonKeyProps).filter((k) => k !== 'ref').length > 0) {
        return createElement(
          'span' as ElementType,
          { ...nonKeyProps, ref },
          resolvedChildren as ComponentChildren
        );
      }
    }
    return createElement(Fragment, null, resolvedChildren as ComponentChildren);
  }

  return createElement(Component as string, finalProps, resolvedChildren as ComponentChildren);
}

// Merge two props objects, handling className and event handler concatenation
export function mergeProps(...propsList: Record<string, unknown>[]): Record<string, unknown> {
  if (propsList.length === 0) return {};
  if (propsList.length === 1) return propsList[0];

  const result: Record<string, unknown> = {};

  const eventHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  for (const props of propsList) {
    for (const [key, value] of Object.entries(props)) {
      // Merge class/className
      if (key === 'className' || key === 'class') {
        const existing = (result.class || result.className || '') as string;
        const incoming = (value || '') as string;
        const merged = [existing, incoming].filter(Boolean).join(' ');
        delete result.className;
        result.class = merged || undefined;
        continue;
      }

      // Merge event handlers
      if (key.startsWith('on') && typeof value === 'function') {
        if (!eventHandlers[key]) {
          eventHandlers[key] = [];
          // Capture any pre-existing handler (from outside propsList) on first encounter
          if (result[key] && typeof result[key] === 'function') {
            eventHandlers[key].push(result[key] as (...args: unknown[]) => void);
          }
        }
        eventHandlers[key].push(value as (...args: unknown[]) => void);
        const handlers = eventHandlers[key];
        result[key] = (...args: unknown[]) => {
          for (const handler of handlers) {
            handler(...args);
          }
        };
        continue;
      }

      // Merge style objects
      if (key === 'style' && typeof value === 'object' && typeof result[key] === 'object') {
        result[key] = {
          ...(result[key] as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        };
        continue;
      }

      result[key] = value;
    }
  }

  return result;
}
