import {
  autoUpdate,
  flip as flipMiddleware,
  offset as offsetMiddleware,
  shift as shiftMiddleware,
  size as sizeMiddleware,
  type Placement as FloatingPlacement,
  type Middleware,
} from '@floating-ui/dom';
import { createContext, type ComponentChildren, type JSX } from 'preact';
import { useCallback, useContext, useMemo, useRef, useState } from 'preact/hooks';
import { disposables } from './disposables.ts';
import { env } from './env.ts';
import { useEvent } from './use-event.ts';
import { useIsoMorphicEffect } from './use-iso-morphic-effect.ts';
import type {
  Align,
  AnchorPropsWithSelection,
  AnchorToWithSelection,
  InternalFloatingPanelProps,
  Placement,
} from './use-anchor-props.ts';

/**
 * CSS properties type for style objects.
 */
export type CSSProperties = Record<string, string | number | undefined>;

/**
 * Context for floating UI state.
 */
interface FloatingContextValue {
  styles: CSSProperties | undefined;
  setReference: (node: HTMLElement | null) => void;
  setFloating: (node: HTMLElement | null) => void;
  getReferenceProps: <T extends Record<string, unknown>>(props?: T) => T;
  getFloatingProps: <T extends Record<string, unknown>>(
    props?: T
  ) => T & { 'data-anchor': string | undefined };
  slot: {
    anchor: AnchorToWithSelection | undefined;
  };
}

// Default context value with proper implementations
const defaultFloatingContext: FloatingContextValue = {
  styles: undefined,
  setReference: () => {},
  setFloating: () => {},
  getReferenceProps: <T extends Record<string, unknown>>(props?: T): T => {
    return (props ?? {}) as T;
  },
  getFloatingProps: <T extends Record<string, unknown>>(
    props?: T
  ): T & { 'data-anchor': string | undefined } => {
    return { ...props, 'data-anchor': undefined } as T & { 'data-anchor': string | undefined };
  },
  slot: { anchor: undefined },
};

const FloatingContext = createContext<FloatingContextValue>(defaultFloatingContext);
FloatingContext.displayName = 'FloatingContext';

/**
 * Context for updating placement configuration.
 */
type PlacementUpdateFn = (value: Exclude<AnchorPropsWithSelection, boolean> | null) => void;

const PlacementContext = createContext<PlacementUpdateFn | null>(null);
PlacementContext.displayName = 'PlacementContext';

/**
 * Hook to get the setReference function from FloatingContext.
 */
export function useFloatingReference(): (node: HTMLElement | null) => void {
  return useContext(FloatingContext).setReference;
}

/**
 * Hook to get reference props from FloatingContext.
 */
export function useFloatingReferenceProps(): <T extends Record<string, unknown>>(props?: T) => T {
  return useContext(FloatingContext).getReferenceProps;
}

/**
 * Hook to get floating panel props with data-anchor attribute.
 */
export function useFloatingPanelProps(): <T extends Record<string, unknown>>(
  props?: T
) => T & { 'data-anchor': string | undefined } {
  const { getFloatingProps, slot } = useContext(FloatingContext);

  return useCallback(
    <T extends Record<string, unknown>>(props?: T): T & { 'data-anchor': string | undefined } => {
      return Object.assign({}, getFloatingProps(props), {
        'data-anchor': slot.anchor,
      }) as T & { 'data-anchor': string | undefined };
    },
    [getFloatingProps, slot]
  );
}

/**
 * Hook to connect a floating panel to the floating context.
 *
 * @param placement - The anchor configuration
 * @returns Tuple of [setFloating ref callback, styles object]
 */
export function useFloatingPanel(
  placement: (AnchorPropsWithSelection & InternalFloatingPanelProps) | null = null
): readonly [(node: HTMLElement | null) => void, CSSProperties] {
  // Normalize placement
  if (placement === false) placement = null; // Disable entirely
  if (typeof placement === 'string') placement = { to: placement }; // Simple string based value

  const updatePlacementConfig = useContext(PlacementContext);

  // Stable placement for deep comparison
  const stablePlacement = useMemo(
    () => placement,
    [
      JSON.stringify(placement, (_, v) => {
        // When we are trying to stringify a DOM element, we want to return the
        // `outerHTML` of the element. In all other cases, we want to return the
        // value as-is.
        // It's not safe enough to check whether `v` is an instanceof
        // `HTMLElement` because some tools (like AG Grid) polyfill it to be `{}`.
        return (v as HTMLElement | undefined)?.outerHTML ?? v;
      }),
    ]
  );

  useIsoMorphicEffect(() => {
    updatePlacementConfig?.(stablePlacement ?? null);
  }, [updatePlacementConfig, stablePlacement]);

  const context = useContext(FloatingContext);

  return useMemo(
    () => [context.setFloating, placement ? (context.styles ?? {}) : {}] as const,
    [context.setFloating, placement, context.styles]
  );
}

interface FloatingProviderProps {
  children: ComponentChildren;
  enabled?: boolean;
}

/**
 * Provider component for floating UI positioning.
 *
 * Wraps components that need anchor positioning and provides:
 * - Automatic position computation via @floating-ui/dom
 * - Dynamic placement updates
 * - Viewport collision detection (flip/shift)
 * - Size constraints
 *
 * @example
 * ```tsx
 * <FloatingProvider>
 *   <MenuButton ref={useFloatingReference()}>Toggle</MenuButton>
 *   <MenuItems {...useFloatingPanelProps()}>
 *     {items}
 *   </MenuItems>
 * </FloatingProvider>
 * ```
 */
export function FloatingProvider({ children, enabled = true }: FloatingProviderProps): JSX.Element {
  const [config, setConfig] = useState<
    (AnchorPropsWithSelection & InternalFloatingPanelProps) | null
  >(null);

  // Element state
  const [referenceEl, setReferenceEl] = useState<HTMLElement | null>(null);
  const [floatingEl, setFloatingEl] = useState<HTMLElement | null>(null);

  // Position state
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [actualPlacement, setActualPlacement] = useState<FloatingPlacement>('bottom');

  // Cleanup ref
  const cleanupRef = useRef<(() => void) | null>(null);
  const d = useRef(disposables());

  // Fix scrolling pixel issue
  useFixScrollingPixel(floatingEl);

  const isEnabled = enabled && config !== null && floatingEl !== null;

  // Resolve config values
  // Note: 'inner' middleware support is simplified - it's parsed but full implementation is deferred
  const {
    to: placement = 'bottom',
    gap = 0,
    offset = 0,
    padding = 0,
  } = useResolvedConfig(config, floatingEl);

  const [to, align = 'center'] = placement.split(' ') as [
    Placement | 'selection',
    Align | 'center',
  ];

  // Convert placement to FloatingPlacement
  const floatingPlacement = useMemo((): FloatingPlacement => {
    if (to === 'selection') {
      return align === 'center' ? 'bottom' : `bottom-${align}`;
    }
    return align === 'center' ? to : `${to}-${align}`;
  }, [to, align]);

  // Build middleware array
  const middleware = useMemo((): Middleware[] => {
    const m: (Middleware | false)[] = [
      // Offset middleware for gap and cross-axis offset
      offsetMiddleware({
        mainAxis: to === 'selection' ? 0 : gap,
        crossAxis: offset,
      }),

      // Shift middleware to keep panel in viewport
      shiftMiddleware({ padding }),

      // Flip middleware (not compatible with selection/inner)
      to !== 'selection' && flipMiddleware({ padding }),

      // Size middleware to constrain panel size
      sizeMiddleware({
        padding,
        apply({ availableWidth, availableHeight, elements }) {
          Object.assign(elements.floating.style, {
            overflow: 'auto',
            maxWidth: `${availableWidth}px`,
            maxHeight: `min(var(--anchor-max-height, 100vh), ${availableHeight}px)`,
          });
        },
      }),
    ];

    return m.filter(Boolean) as Middleware[];
  }, [to, gap, offset, padding]);

  // Compute position
  const updatePosition = useEvent(async () => {
    if (!referenceEl || !floatingEl || !isEnabled) return;

    // Skip on server
    if (env.isServer) return;

    try {
      const { computePosition } = await import('@floating-ui/dom');
      const result = await computePosition(referenceEl, floatingEl, {
        placement: floatingPlacement,
        strategy: 'absolute',
        middleware,
      });

      setPosition({ x: result.x, y: result.y });
      setActualPlacement(result.placement);
    } catch {
      // Ignore errors
    }
  });

  // Set up autoUpdate when elements are mounted
  useIsoMorphicEffect(() => {
    if (!isEnabled || !referenceEl || !floatingEl) {
      return;
    }

    // Skip on server
    if (env.isServer) return;

    // Clean up previous
    if (cleanupRef.current) {
      cleanupRef.current();
    }

    // Initial position
    void updatePosition();

    // Set up autoUpdate
    cleanupRef.current = autoUpdate(referenceEl, floatingEl, updatePosition, {
      ancestorScroll: true,
      ancestorResize: true,
      elementResize: true,
      layoutShift: true,
      animationFrame: false,
    });

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [isEnabled, referenceEl, floatingEl, updatePosition]);

  // Cleanup on unmount
  useIsoMorphicEffect(() => {
    return () => {
      d.current.dispose();
    };
  }, []);

  // Calculate exposed anchor data
  const [exposedTo = to, exposedAlign = align] = actualPlacement.split('-');
  const finalExposedTo = to === 'selection' ? 'selection' : exposedTo;

  const slot = useMemo(
    () => ({
      anchor: [finalExposedTo, exposedAlign].filter(Boolean).join(' ') as AnchorToWithSelection,
    }),
    [finalExposedTo, exposedAlign]
  );

  // Build floating styles
  const floatingStyles = useMemo((): CSSProperties => {
    if (!isEnabled) return {};

    return {
      position: 'absolute',
      left: position.x,
      top: position.y,
      willChange: 'transform',
    };
  }, [isEnabled, position.x, position.y]);

  // Props getters
  const getReferenceProps = useCallback(
    <T extends Record<string, unknown>>(props?: T): T => props ?? ({} as T),
    []
  );

  const getFloatingProps = useCallback(
    <T extends Record<string, unknown>>(props?: T): T & { 'data-anchor': string | undefined } => {
      return {
        ...props,
        'data-anchor': slot.anchor,
      } as T & { 'data-anchor': string | undefined };
    },
    [slot.anchor]
  );

  // Combined setFloating that updates both refs
  const setFloatingRef = useEvent((el: HTMLElement | null) => {
    setFloatingEl(el);
  });

  // Set reference element
  const setReferenceRef = useEvent((el: HTMLElement | null) => {
    setReferenceEl(el);
  });

  return (
    <PlacementContext.Provider value={setConfig}>
      <FloatingContext.Provider
        value={{
          setFloating: setFloatingRef,
          setReference: setReferenceRef,
          styles: floatingStyles,
          getReferenceProps,
          getFloatingProps,
          slot,
        }}
      >
        {children}
      </FloatingContext.Provider>
    </PlacementContext.Provider>
  );
}

/**
 * Hook to fix the scrolling pixel issue in floating panels.
 *
 * When maxHeight is set to a fractional pixel value, some browsers
 * can have scrolling issues. This rounds up to the nearest integer.
 */
function useFixScrollingPixel(element: HTMLElement | null): void {
  useIsoMorphicEffect(() => {
    if (!element) return;

    const observer = new MutationObserver(() => {
      const maxHeight = window.getComputedStyle(element).maxHeight;

      const maxHeightFloat = parseFloat(maxHeight);
      if (isNaN(maxHeightFloat)) return;

      const maxHeightInt = parseInt(maxHeight, 10);
      if (isNaN(maxHeightInt)) return;

      if (maxHeightFloat !== maxHeightInt) {
        element.style.maxHeight = `${Math.ceil(maxHeightFloat)}px`;
      }
    });

    observer.observe(element, {
      attributes: true,
      attributeFilter: ['style'],
    });

    return () => {
      observer.disconnect();
    };
  }, [element]);
}

/**
 * Hook to resolve anchor config with CSS variable support.
 */
function useResolvedConfig(
  config: (Exclude<AnchorPropsWithSelection, boolean | string> & InternalFloatingPanelProps) | null,
  element?: HTMLElement | null
) {
  const gap = useResolvePxValue(config?.gap ?? 'var(--anchor-gap, 0)', element);
  const offset = useResolvePxValue(config?.offset ?? 'var(--anchor-offset, 0)', element);
  const padding = useResolvePxValue(config?.padding ?? 'var(--anchor-padding, 0)', element);

  return { ...config, gap, offset, padding };
}

/**
 * Hook to resolve a CSS value (number or CSS variable) to pixels.
 *
 * @param input - The value to resolve (number or CSS string)
 * @param element - The element to use for CSS variable resolution
 * @param defaultValue - Default value if resolution fails
 * @returns The resolved pixel value
 */
function useResolvePxValue(
  input?: string | number,
  element?: HTMLElement | null,
  defaultValue: number | undefined = undefined
): number | undefined {
  const d = useRef(disposables());

  type WatcherFn = (setValue: (value?: number) => void) => void;
  type ComputeResult = readonly [number | undefined, WatcherFn | null];

  const computeValue = useEvent(
    (value?: string | number, el?: HTMLElement | null): ComputeResult => {
      // Nullish
      if (value == null) return [defaultValue, null] as const;

      // Number as-is
      if (typeof value === 'number') return [value, null] as const;

      // String values
      if (typeof value === 'string') {
        if (!el) return [defaultValue, null] as const;

        const result = resolveCSSVariablePxValue(value, el);

        const watcher: WatcherFn = (setValue: (value?: number) => void) => {
          const variables = resolveVariables(value);

          // Poll for CSS variable changes (performant enough for our use case)
          const history = variables.map((variable) =>
            window.getComputedStyle(el!).getPropertyValue(variable)
          );

          d.current.requestAnimationFrame(function check() {
            d.current.nextFrame(check);

            // Fast path: check if any variable changed
            let changed = false;
            for (const [idx, variable] of variables.entries()) {
              const currentValue = window.getComputedStyle(el!).getPropertyValue(variable);
              if (history[idx] !== currentValue) {
                history[idx] = currentValue;
                changed = true;
                break;
              }
            }

            if (!changed) return;

            const newResult = resolveCSSVariablePxValue(value, el!);

            if (result !== newResult) {
              setValue(newResult);
            }
          });
        };

        return [result, watcher] as const;
      }

      return [defaultValue, null] as const;
    }
  );

  // Calculate immediate value
  const immediateValue = useMemo(() => computeValue(input, element)[0], [input, element]);

  const [value = immediateValue, setValue] = useState<number | undefined>();

  useIsoMorphicEffect(() => {
    const [computedValue, watcher] = computeValue(input, element);
    setValue(computedValue);

    if (watcher) {
      watcher(setValue);
    }
  }, [input, element]);

  // Cleanup on unmount
  useIsoMorphicEffect(() => {
    return () => {
      d.current.dispose();
    };
  }, []);

  return value;
}

/**
 * Extract CSS variable names from a value string.
 */
function resolveVariables(value: string): string[] {
  const matches = /var\((.*)\)/.exec(value);
  if (matches) {
    const idx = matches[1].indexOf(',');
    if (idx === -1) {
      return [matches[1]];
    }

    const variable = matches[1].slice(0, idx).trim();
    const fallback = matches[1].slice(idx + 1).trim();

    if (fallback) {
      return [variable, ...resolveVariables(fallback)];
    }

    return [variable];
  }

  return [];
}

/**
 * Resolve a CSS value to pixels using a temporary element.
 *
 * This handles CSS variables, calc(), rem, vh, etc. by letting
 * the browser compute the actual pixel value.
 */
function resolveCSSVariablePxValue(input: string, element: HTMLElement): number {
  // Create temporary element to compute the value
  const tmpEl = document.createElement('div');
  element.appendChild(tmpEl);

  // Set initial value to 0px (fallback for invalid values)
  tmpEl.style.setProperty('margin-top', '0px', 'important');

  // Set the target value
  tmpEl.style.setProperty('margin-top', input, 'important');

  // Read computed value (browser converts to pixels)
  const pxValue = parseFloat(window.getComputedStyle(tmpEl).marginTop) || 0;
  element.removeChild(tmpEl);

  return pxValue;
}
