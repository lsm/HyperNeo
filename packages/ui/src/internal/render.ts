import { type ComponentChildren, createElement, Fragment, type Ref, type VNode } from 'preact';
import { type ElementType, Features, RenderStrategy } from './types.ts';

function mergeDataAttributes(slot: Record<string, unknown>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};

  let hasBooleanState = false;
  const truthyStates: string[] = [];

  for (const [key, value] of Object.entries(slot)) {
    if (typeof value === 'boolean') {
      hasBooleanState = true;
      const kebabKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      if (value) {
        truthyStates.push(kebabKey);
      }
    }
  }

  if (hasBooleanState) {
    result['data-headlessui-state'] = truthyStates.length > 0 ? truthyStates.join(' ') : '';
    for (const state of truthyStates) {
      result[`data-${state}`] = '';
    }
  }

  return result;
}

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
  const props = mergeProps(theirProps, ourProps);

  if (!visible) {
    if (features !== undefined && features & Features.Static) {
      const { static: isStatic = false, ...rest } = props as Record<string, unknown> & {
        static?: boolean;
      };
      if (isStatic) {
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

  const resolvedChildren = typeof children === 'function' ? children(slot) : children;

  const dataAttrs = mergeDataAttributes(slot);
  const finalProps = compact({ ...rest, ...dataAttrs, ref });

  if (Component === Fragment) {
    if (Object.keys(finalProps).length > 0) {
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

export function mergeProps(...propsList: Record<string, unknown>[]): Record<string, unknown> {
  if (propsList.length === 0) return {};
  if (propsList.length === 1) return propsList[0];

  const result: Record<string, unknown> = {};

  const eventHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  for (const props of propsList) {
    for (const [key, value] of Object.entries(props)) {
      if (key === 'className' || key === 'class') {
        const existing = (result.class || result.className || '') as string;
        const incoming = (value || '') as string;
        const merged = [existing, incoming].filter(Boolean).join(' ');
        delete result.className;
        result.class = merged || undefined;
        continue;
      }

      if (key.startsWith('on') && typeof value === 'function') {
        if (!eventHandlers[key]) {
          eventHandlers[key] = [];
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
