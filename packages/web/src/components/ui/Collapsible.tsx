import { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import { borderColors } from '../../lib/design-tokens.ts';

export interface CollapsibleProps {
  trigger: ComponentChildren;
  children: ComponentChildren;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  class?: string;
}

export function Collapsible({
  trigger,
  children,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  class: className,
}: CollapsibleProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(defaultOpen ? undefined : 0);

  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;

  const toggle = () => {
    const newOpen = !isOpen;
    if (controlledOpen === undefined) {
      setInternalOpen(newOpen);
    }
    onOpenChange?.(newOpen);
  };

  useEffect(() => {
    if (contentRef.current) {
      if (isOpen) {
        const scrollHeight = contentRef.current.scrollHeight;
        setHeight(scrollHeight);
        const timer = setTimeout(() => setHeight(undefined), 200);
        return () => clearTimeout(timer);
      } else {
        setHeight(contentRef.current.scrollHeight);
        setTimeout(() => setHeight(0), 0);
      }
    }
  }, [isOpen]);

  return (
    <div class={cn(borderColors.ui.default, className)}>
      <button
        onClick={toggle}
        class="flex items-center justify-between w-full text-left transition-colors"
        aria-expanded={isOpen}
      >
        {trigger}
        <svg
          class={cn('w-4 h-4 transition-transform duration-200', isOpen && 'rotate-180')}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      <div
        ref={contentRef}
        style={{
          height: height !== undefined ? `${height}px` : 'auto',
          overflow: height !== undefined && height === 0 ? 'hidden' : 'visible',
        }}
        class="transition-all duration-200 ease-in-out"
      >
        <div class="pt-2">{children}</div>
      </div>
    </div>
  );
}
