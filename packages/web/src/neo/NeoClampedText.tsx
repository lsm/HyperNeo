import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n/index.ts';

const CLAMP_LINES = 10;

function neoClampHeight(element: HTMLElement, lines = CLAMP_LINES): number | null {
  const top = element.getBoundingClientRect().top;
  const rects: { top: number; bottom: number }[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects())
      if (rect.height > 0) rects.push({ top: rect.top - top, bottom: rect.bottom - top });
  }
  if (!rects.length) {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    return (Number.isFinite(lineHeight) ? lineHeight : 26) * lines;
  }
  const rows = rects
    .sort((a, b) => a.top - b.top)
    .reduce<{ top: number; bottom: number }[]>((found, rect) => {
      const last = found.at(-1);
      if (last && rect.top < last.bottom - 1) last.bottom = Math.max(last.bottom, rect.bottom);
      else found.push({ ...rect });
      return found;
    }, []);
  return rows.length > lines ? Math.ceil(rows[lines - 1].bottom) : null;
}

export function NeoClampedText({ text, children }: { text: string; children: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    if (open) {
      element.style.maxHeight = '';
      return;
    }
    const measure = () => {
      const height = neoClampHeight(element);
      element.style.maxHeight = height === null ? '' : `${height}px`;
      setLong(element.scrollHeight > element.clientHeight + 1);
    };
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
        class={open ? '' : 'overflow-hidden'}
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
          {t(open ? 'chat.showLess' : 'chat.showMore')}
        </button>
      )}
    </>
  );
}
