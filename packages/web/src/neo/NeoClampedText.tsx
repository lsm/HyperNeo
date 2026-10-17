import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

export const NEO_USER_TEXT_LINES = 10;

export function neoTextOverLines(text: string, lines = NEO_USER_TEXT_LINES): boolean {
  return text.split('\n').length > lines;
}

export function NeoClampedText({ text, children }: { text: string; children: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (element && !open) setOverflows(element.scrollHeight > element.clientHeight + 1);
  }, [text, open]);
  const long = overflows || neoTextOverLines(text);
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
