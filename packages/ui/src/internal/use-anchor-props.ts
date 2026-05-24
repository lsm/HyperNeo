import { useMemo } from 'preact/hooks';

/**
 * Alignment options for anchor positioning.
 */
export type Align = 'start' | 'end';

/**
 * Placement options for anchor positioning.
 */
export type Placement = 'top' | 'right' | 'bottom' | 'left';

/**
 * Anchor placement string format: "placement" or "placement align".
 */
export type AnchorTo = `${Placement}` | `${Placement} ${Align}`;

/**
 * Anchor placement with selection support (for combobox).
 */
export type AnchorToWithSelection =
  | `${Placement | 'selection'}`
  | `${Placement | 'selection'} ${Align}`;

/**
 * Base anchor configuration properties.
 */
type BaseAnchorProps = {
  /**
   * The gap is the space between the trigger and the panel.
   */
  gap: number | string; // For `var()` support

  /**
   * The offset is the amount the panel should be nudged from its original position.
   */
  offset: number | string; // For `var()` support

  /**
   * The padding is the minimum space between the panel and the viewport.
   */
  padding: number | string; // For `var()` support
};

/**
 * Anchor props for positioning floating panels.
 *
 * Can be:
 * - `false` to disable anchoring entirely
 * - A string like "bottom start" for simple placement
 * - An object with `to`, `gap`, `offset`, and `padding` properties
 *
 * @example
 * ```tsx
 * // String form
 * <MenuItems anchor="bottom start">
 *
 * // Object form
 * <MenuItems anchor={{ to: 'bottom', gap: 8, offset: 0, padding: 16 }}>
 *
 * // Disabled
 * <MenuItems anchor={false}>
 * ```
 */
export type AnchorProps =
  | false // Disable entirely
  | AnchorTo // String value to define the placement
  | Partial<
      BaseAnchorProps & {
        /**
         * The to value defines which side of the trigger the panel should be placed on and its
         * alignment.
         */
        to: AnchorTo;
      }
    >;

/**
 * Anchor props with selection support (for combobox).
 *
 * Extends AnchorProps to include 'selection' as a placement option,
 * which positions the panel relative to the selected item.
 */
export type AnchorPropsWithSelection =
  | false // Disable entirely
  | AnchorToWithSelection
  | Partial<
      BaseAnchorProps & {
        /**
         * The to value defines which side of the trigger the panel should be placed on and its
         * alignment.
         */
        to: AnchorToWithSelection;
      }
    >;

/**
 * Internal props for floating panel with inner middleware support.
 */
export type InternalFloatingPanelProps = Partial<{
  inner: {
    listRef: React.MutableRefObject<(HTMLElement | null)[]>;
    index: number;
  };
}>;

/**
 * Hook to normalize anchor prop into a consistent object format.
 *
 * @param anchor - The anchor prop value
 * @returns Normalized anchor configuration object, or null if disabled
 *
 * @example
 * ```tsx
 * useResolvedAnchor("bottom start") // { to: "bottom start" }
 * useResolvedAnchor({ to: "bottom", gap: 8 }) // { to: "bottom", gap: 8 }
 * useResolvedAnchor(false) // null
 * ```
 */
export function useResolvedAnchor<T extends AnchorProps | AnchorPropsWithSelection>(
  anchor?: T
): Exclude<T, boolean | string> | null {
  return useMemo(() => {
    if (!anchor) return null; // Disable entirely
    if (typeof anchor === 'string') return { to: anchor } as Exclude<T, boolean | string>; // Simple string based value
    return anchor as Exclude<T, boolean | string>; // User-provided value
  }, [anchor]);
}
