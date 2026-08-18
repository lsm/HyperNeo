import { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import { borderColors } from '../../lib/design-tokens.ts';

export interface TooltipProps {
  content: string;
  children: ComponentChildren;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

export function Tooltip({ content, children, position = 'top', delay = 500 }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  let timeoutId: ReturnType<typeof setTimeout>;

  const handleMouseEnter = () => {
    timeoutId = setTimeout(() => setIsVisible(true), delay);
  };

  const handleMouseLeave = () => {
    clearTimeout(timeoutId);
    setIsVisible(false);
  };

  const positions = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  const arrowPositions = {
    top: 'top-full left-1/2 -translate-x-1/2 -mt-1',
    bottom: 'bottom-full left-1/2 -translate-x-1/2 -mb-1 rotate-180',
    left: 'left-full top-1/2 -translate-y-1/2 -ml-1 -rotate-90',
    right: 'right-full top-1/2 -translate-y-1/2 -mr-1 rotate-90',
  };

  return (
    <div
      class="relative inline-block"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {isVisible && (
        <div
          class={cn(
            `absolute z-50 px-3 py-1.5 text-xs text-white bg-dark-800 rounded-md shadow-lg border ${borderColors.ui.secondary} whitespace-nowrap pointer-events-none animate-fadeIn`,
            positions[position]
          )}
          role="tooltip"
        >
          {content}
          <div
            class={cn(
              'absolute w-0 h-0 border-4 border-transparent border-t-dark-800',
              arrowPositions[position]
            )}
          />
        </div>
      )}
    </div>
  );
}
