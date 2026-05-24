import { useMemo } from 'preact/hooks';
import type { ElementType } from './types.ts';

/**
 * Props that might contain an `as` prop to determine the element type.
 */
type HasAsProp = {
  as?: ElementType | undefined;
};

/**
 * Props that might contain a `type` prop.
 */
type HasTypeProp = {
  type?: string | undefined;
};

/**
 * Resolve the button type based on the element and props.
 *
 * This ensures that buttons have a proper `type="button"` attribute when:
 * 1. The element is a native `<button>` element
 * 2. No explicit `type` prop was provided
 *
 * This is important because HTML buttons default to `type="submit"` which
 * can accidentally submit forms.
 *
 * @param props - The component props (may contain `as` and `type`)
 * @param element - The current DOM element (to check if it's a button)
 * @returns The resolved type attribute, or undefined if not needed
 *
 * @example
 * ```tsx
 * function Button(props) {
 *   const ref = useRef(null);
 *   const type = useResolveButtonType(props, ref.current);
 *   return <button ref={ref} type={type} {...props} />;
 * }
 * ```
 */
export function useResolveButtonType(
  props: HasAsProp & HasTypeProp,
  element: HTMLElement | null
): string | undefined {
  return useMemo(() => {
    // If type is explicitly provided, use it
    if (props.type) return props.type;

    // If `as` prop is provided and it's not a string 'button', don't add type
    if (props.as !== undefined && props.as !== 'button') {
      return undefined;
    }

    // Check if this is a native button element
    const tagName = element?.tagName?.toLowerCase();

    // Only add type="button" to actual button elements
    if (tagName === 'button') {
      return 'button';
    }

    // For non-button elements (including `as="div"` etc), no type needed
    return undefined;
  }, [props.type, props.as, element?.tagName]);
}
