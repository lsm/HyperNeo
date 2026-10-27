import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n/index.ts';

const CLAMP_LINES = 10;

function neoClampHeight(element: HTMLElement, lines = CLAMP_LINES) {
  const top = element.getBoundingClientRect().top;
  const rects: { top: number; bottom: number; left: number; right: number }[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects())
      if (rect.height > 0)
        rects.push({
          top: rect.top - top,
          bottom: rect.bottom - top,
          left: rect.left,
          right: rect.right,
        });
  }
  if (!rects.length) {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    return { height: (Number.isFinite(lineHeight) ? lineHeight : 26) * lines, marked: true };
  }
  const rows = rects
    .sort((a, b) => a.top - b.top)
    .reduce<typeof rects>((found, rect) => {
      const last = found.at(-1);
      if (last && rect.top < last.bottom - 1) {
        last.bottom = Math.max(last.bottom, rect.bottom);
        last.left = Math.min(last.left, rect.left);
        last.right = Math.max(last.right, rect.right);
      } else found.push({ ...rect });
      return found;
    }, []);
  if (rows.length <= lines) return { height: null, marked: false };
  const wordLine = rows
    .slice(Math.max(0, lines - 4), lines)
    .reverse()
    .find((row) => row.right - row.left >= element.clientWidth / 4);
  return { height: Math.ceil((wordLine ?? rows[lines - 1]).bottom), marked: !wordLine };
}

export function NeoClampedText({ text, children }: { text: string; children: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const [marked, setMarked] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    if (open) {
      element.style.maxHeight = '';
      return;
    }
    const measure = () => {
      const { height, marked } = neoClampHeight(element);
      setMarked(marked);
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
    <div
      class={`relative flow-root ${long ? 'cursor-pointer focus-visible:outline-accent' : ''}`}
      role={long ? 'button' : undefined}
      tabIndex={long ? 0 : undefined}
      aria-expanded={long ? open : undefined}
      aria-label={long ? t(open ? 'chat.showLess' : 'chat.showMore') : undefined}
      onClick={(event) => {
        if (!long || event.defaultPrevented || window.getSelection()?.toString()) return;
        if (
          event.target instanceof Element &&
          event.target.closest('a,button,input,select,textarea')
        )
          return;
        setOpen(!open);
      }}
      onKeyDown={(event) => {
        if (!long || event.target !== event.currentTarget || !['Enter', ' '].includes(event.key))
          return;
        event.preventDefault();
        setOpen(!open);
      }}
    >
      <div
        ref={box}
        data-clamped={!open && long ? '' : undefined}
        class={open ? '' : 'overflow-hidden'}
      >
        {children}
      </div>
      {!open && long && marked && (
        <span aria-hidden="true" class="pointer-events-none absolute bottom-0 left-0 text-fg-muted">
          ⋯
        </span>
      )}
    </div>
  );
}
