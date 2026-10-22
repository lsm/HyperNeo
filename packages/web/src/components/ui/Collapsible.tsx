import { ContentDisclosureControl } from './ContentDisclosureControl.tsx';
import { ComponentChildren } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';

export interface CollapsibleProps {
  trigger: ComponentChildren;
  label?: string;
  children: ComponentChildren;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  class?: string;
}

export function Collapsible({
  trigger,
  children,
  label = 'Details',
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  class: className,
}: CollapsibleProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const id = useId();
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

  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(`button[aria-controls="${id}"]`)
      ?.focus({ preventScroll: true });
  }, [isOpen, id]);

  const control = (
    <ContentDisclosureControl
      expanded={isOpen}
      aria-label={label}
      aria-controls={id}
      onToggle={() => {
        restoreFocus.current = true;
        toggle();
      }}
    />
  );

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
    <div ref={rootRef} class={cn('border-line', className)}>
      <div class="flow-root">
        {trigger}
        {!isOpen && control}
      </div>

      <div
        ref={contentRef}
        id={id}
        style={{
          height: height !== undefined ? `${height}px` : 'auto',
          overflow: height !== undefined && height === 0 ? 'hidden' : 'visible',
        }}
        class="transition-all duration-200 ease-in-out"
      >
        <div class="pt-2">{children}</div>
        {isOpen && <div class="flow-root">{control}</div>}
      </div>
    </div>
  );
}
