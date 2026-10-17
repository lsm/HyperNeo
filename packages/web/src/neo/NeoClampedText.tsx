import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

export function NeoClampedText({ text, children }: { text: string; children: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || open) return;
    const measure = () => setLong(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);
  return (
    <>
      <div
        ref={box}
        data-clamped={!open && long ? '' : undefined}
        class={open ? '' : 'line-clamp-10'}
      >
        {children}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          class="mt-1 text-xs text-fg-muted hover:text-fg hover:underline"
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}
