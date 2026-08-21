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

export type CSSProperties = Record<string, string | number | undefined>;

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

type PlacementUpdateFn = (value: Exclude<AnchorPropsWithSelection, boolean> | null) => void;

const PlacementContext = createContext<PlacementUpdateFn | null>(null);
PlacementContext.displayName = 'PlacementContext';

export function useFloatingReference(): (node: HTMLElement | null) => void {
  return useContext(FloatingContext).setReference;
}

export function useFloatingReferenceProps(): <T extends Record<string, unknown>>(props?: T) => T {
  return useContext(FloatingContext).getReferenceProps;
}

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

export function useFloatingPanel(
  placement: (AnchorPropsWithSelection & InternalFloatingPanelProps) | null = null
): readonly [(node: HTMLElement | null) => void, CSSProperties] {
  if (placement === false) placement = null;
  if (typeof placement === 'string') placement = { to: placement };

  const updatePlacementConfig = useContext(PlacementContext);

  const stablePlacement = useMemo(
    () => placement,
    [
      JSON.stringify(placement, (_, v) => {
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

export function FloatingProvider({ children, enabled = true }: FloatingProviderProps): JSX.Element {
  const [config, setConfig] = useState<
    (AnchorPropsWithSelection & InternalFloatingPanelProps) | null
  >(null);

  const [referenceEl, setReferenceEl] = useState<HTMLElement | null>(null);
  const [floatingEl, setFloatingEl] = useState<HTMLElement | null>(null);

  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [actualPlacement, setActualPlacement] = useState<FloatingPlacement>('bottom');

  const cleanupRef = useRef<(() => void) | null>(null);
  const d = useRef(disposables());

  useFixScrollingPixel(floatingEl);

  const isEnabled = enabled && config !== null && floatingEl !== null;

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

  const floatingPlacement = useMemo((): FloatingPlacement => {
    if (to === 'selection') {
      return align === 'center' ? 'bottom' : `bottom-${align}`;
    }
    return align === 'center' ? to : `${to}-${align}`;
  }, [to, align]);

  const middleware = useMemo((): Middleware[] => {
    const m: (Middleware | false)[] = [
      offsetMiddleware({
        mainAxis: to === 'selection' ? 0 : gap,
        crossAxis: offset,
      }),

      shiftMiddleware({ padding }),

      to !== 'selection' && flipMiddleware({ padding }),

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

  const updatePosition = useEvent(async () => {
    if (!referenceEl || !floatingEl || !isEnabled) return;

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
    } catch {}
  });

  useIsoMorphicEffect(() => {
    if (!isEnabled || !referenceEl || !floatingEl) {
      return;
    }

    if (env.isServer) return;

    if (cleanupRef.current) {
      cleanupRef.current();
    }

    void updatePosition();

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

  useIsoMorphicEffect(() => {
    return () => {
      d.current.dispose();
    };
  }, []);

  const [exposedTo = to, exposedAlign = align] = actualPlacement.split('-');
  const finalExposedTo = to === 'selection' ? 'selection' : exposedTo;

  const slot = useMemo(
    () => ({
      anchor: [finalExposedTo, exposedAlign].filter(Boolean).join(' ') as AnchorToWithSelection,
    }),
    [finalExposedTo, exposedAlign]
  );

  const floatingStyles = useMemo((): CSSProperties => {
    if (!isEnabled) return {};

    return {
      position: 'absolute',
      left: position.x,
      top: position.y,
      willChange: 'transform',
    };
  }, [isEnabled, position.x, position.y]);

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

  const setFloatingRef = useEvent((el: HTMLElement | null) => {
    setFloatingEl(el);
  });

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

function useResolvedConfig(
  config: (Exclude<AnchorPropsWithSelection, boolean | string> & InternalFloatingPanelProps) | null,
  element?: HTMLElement | null
) {
  const gap = useResolvePxValue(config?.gap ?? 'var(--anchor-gap, 0)', element);
  const offset = useResolvePxValue(config?.offset ?? 'var(--anchor-offset, 0)', element);
  const padding = useResolvePxValue(config?.padding ?? 'var(--anchor-padding, 0)', element);

  return { ...config, gap, offset, padding };
}

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
      if (value == null) return [defaultValue, null] as const;

      if (typeof value === 'number') return [value, null] as const;

      if (typeof value === 'string') {
        if (!el) return [defaultValue, null] as const;

        const result = resolveCSSVariablePxValue(value, el);

        const watcher: WatcherFn = (setValue: (value?: number) => void) => {
          const variables = resolveVariables(value);

          const history = variables.map((variable) =>
            window.getComputedStyle(el!).getPropertyValue(variable)
          );

          d.current.requestAnimationFrame(function check() {
            d.current.nextFrame(check);

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

  const immediateValue = useMemo(() => computeValue(input, element)[0], [input, element]);

  const [value = immediateValue, setValue] = useState<number | undefined>();

  useIsoMorphicEffect(() => {
    const [computedValue, watcher] = computeValue(input, element);
    setValue(computedValue);

    if (watcher) {
      watcher(setValue);
    }
  }, [input, element]);

  useIsoMorphicEffect(() => {
    return () => {
      d.current.dispose();
    };
  }, []);

  return value;
}

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

function resolveCSSVariablePxValue(input: string, element: HTMLElement): number {
  const tmpEl = document.createElement('div');
  element.appendChild(tmpEl);

  tmpEl.style.setProperty('margin-top', '0px', 'important');

  tmpEl.style.setProperty('margin-top', input, 'important');

  const pxValue = parseFloat(window.getComputedStyle(tmpEl).marginTop) || 0;
  element.removeChild(tmpEl);

  return pxValue;
}
