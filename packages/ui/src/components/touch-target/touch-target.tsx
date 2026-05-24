import type { ComponentChildren } from 'preact';
import type { ElementType } from '../../internal/types.ts';

// --- TouchTarget ---

/**
 * A utility component that expands the touch target area of its parent element
 * to meet WCAG 2.2 Success Criterion 2.5.8 (Minimum Target Size).
 *
 * This component renders an absolutely positioned `<span>` that covers the
 * entire area of its parent, expanding the effective touch target without
 * affecting the visual appearance.
 *
 * Usage: Place this component inside an interactive element (Button, IconButton, etc.)
 * to expand its touch target area. Consumers should apply `pointer-fine:hidden`
 * to this element (via Tailwind or CSS) to ensure the expanded area only
 * intercepts touch events, not mouse/trackpad clicks.
 *
 * @example
 * ```tsx
 * <Button>
 *   <TouchTarget />
 *   Click me
 * </Button>
 * ```
 *
 * With Tailwind:
 * ```tsx
 * <Button class="relative">
 *   <TouchTarget class="pointer-fine:hidden" />
 *   Click me
 * </Button>
 * ```
 *
 * @see https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
 */
interface TouchTargetProps {
  as?: ElementType;
  children?: ComponentChildren;
  class?: string;
  [key: string]: unknown;
}

function TouchTargetFn({
  as: Tag = 'span',
  children,
  class: className,
  ...rest
}: TouchTargetProps) {
  const ourProps: Record<string, unknown> = {
    'aria-hidden': 'true',
    className,
    style: {
      position: 'absolute',
      inset: '0',
    },
  };

  return (
    <Tag {...ourProps} {...rest}>
      {children}
    </Tag>
  );
}

TouchTargetFn.displayName = 'TouchTarget';
export const TouchTarget = TouchTargetFn;
