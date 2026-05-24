/**
 * ContentContainer Component
 *
 * Provides consistent centering and horizontal padding
 * for all main content areas (messages, input, status bar).
 *
 * This ensures perfect alignment across all UI sections and prevents
 * content from touching browser edges on narrow screens.
 *
 * Architecture:
 * - mx-auto: Centers the content horizontally
 * - px-4: Adds 16px horizontal padding on all screen sizes
 * - w-full: Expands to fill available width (critical for flex layouts)
 * - className: Allows custom vertical padding and other styles
 */

import type { ComponentChildren } from 'preact';

interface ContentContainerProps {
  children: ComponentChildren;
  className?: string;
}

export function ContentContainer({ children, className = '' }: ContentContainerProps) {
  const baseClasses = 'mx-auto px-4 w-full';
  const combinedClasses = className ? `${baseClasses} ${className}` : baseClasses;

  return <div class={combinedClasses}>{children}</div>;
}
