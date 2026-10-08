import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';

const OPEN_EDGE = 44;
const BROWSER_EDGE = 12;
const AXIS_SLOP = 10;
const HOLD_MS = 350;
const FLING = 0.5;
const EDITABLE =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], .neo-composer-dock';

export type NeoSheetSwipeAxis = 'wait' | 'swipe' | 'ignore';

export interface NeoSheetSwipeStart {
  x: number;
  width: number;
  opening: boolean;
  target: Element | null;
  selecting: boolean;
}

function scrollsSideways(target: Element): boolean {
  for (
    let node: Element | null = target;
    node && node !== document.body;
    node = node.parentElement
  ) {
    const overflow = getComputedStyle(node).overflowX;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollWidth > node.clientWidth)
      return true;
  }
  return false;
}

export function admitNeoSheetSwipe({
  x,
  width,
  opening,
  target,
  selecting,
}: NeoSheetSwipeStart): boolean {
  if (selecting || !target || target.closest(EDITABLE) || scrollsSideways(target)) return false;
  return opening ? x >= width - OPEN_EDGE && x <= width - BROWSER_EDGE : x >= BROWSER_EDGE * 2;
}

export function readNeoSheetSwipeAxis(
  dx: number,
  dy: number,
  heldMs: number,
  opening: boolean
): NeoSheetSwipeAxis {
  if (Math.abs(dx) < AXIS_SLOP && Math.abs(dy) < AXIS_SLOP) return 'wait';
  if (heldMs > HOLD_MS) return 'ignore';
  return Math.abs(dx) > Math.abs(dy) * 1.5 && (opening ? dx < 0 : dx > 0) ? 'swipe' : 'ignore';
}

export function neoSheetOffset(dx: number, width: number, opening: boolean): number {
  return Math.min(width, Math.max(0, opening ? width + dx : dx));
}

export function settleNeoSheetSwipe(
  dx: number,
  velocity: number,
  width: number,
  opening: boolean
): boolean {
  const travel = opening ? -dx : dx;
  const fling = opening ? -velocity : velocity;
  const moved = travel > width * 0.4 || fling > FLING;
  return opening ? moved : !moved;
}

export function useNeoSheetSwipe({
  enabled,
  open,
  setOpen,
  surface,
  sheet,
}: {
  enabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  surface: RefObject<HTMLElement>;
  sheet: RefObject<HTMLElement>;
}) {
  useEffect(() => {
    const root = surface.current;
    const panel = sheet.current;
    if (!enabled || !root || !panel) return;
    let start: { x: number; y: number; at: number; opening: boolean } | null = null;
    let axis: NeoSheetSwipeAxis = 'wait';
    let last = { x: 0, at: 0 };
    let velocity = 0;
    const release = () => {
      panel.style.transition = '';
      panel.style.transform = '';
      panel.style.visibility = '';
      delete root.dataset.sheetDrag;
      root.style.removeProperty('--neo-sheet');
    };
    const onStart = (event: TouchEvent) => {
      if (axis === 'swipe') release();
      start = null;
      axis = 'wait';
      const touch = event.touches.length === 1 ? event.touches[0] : null;
      if (!touch) return;
      const admitted = admitNeoSheetSwipe({
        x: touch.clientX,
        width: window.innerWidth,
        opening: !open,
        target: event.target instanceof Element ? event.target : null,
        selecting: !(document.getSelection()?.isCollapsed ?? true),
      });
      if (!admitted) return;
      start = { x: touch.clientX, y: touch.clientY, at: event.timeStamp, opening: !open };
      last = { x: touch.clientX, at: event.timeStamp };
      velocity = 0;
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch || axis === 'ignore') return;
      const dx = touch.clientX - start.x;
      if (axis === 'wait') {
        axis = readNeoSheetSwipeAxis(
          dx,
          touch.clientY - start.y,
          event.timeStamp - start.at,
          start.opening
        );
        if (axis !== 'swipe') return;
      }
      velocity = (touch.clientX - last.x) / Math.max(1, event.timeStamp - last.at);
      last = { x: touch.clientX, at: event.timeStamp };
      const offset = neoSheetOffset(dx, window.innerWidth, start.opening);
      panel.style.transition = 'none';
      panel.style.visibility = 'visible';
      panel.style.transform = `translateX(${offset}px)`;
      root.dataset.sheetDrag = '';
      root.style.setProperty('--neo-sheet', String(1 - offset / window.innerWidth));
    };
    const onEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (start && touch && axis === 'swipe') {
        const ends = settleNeoSheetSwipe(
          touch.clientX - start.x,
          velocity,
          window.innerWidth,
          start.opening
        );
        release();
        setOpen(ends);
      }
      start = null;
      axis = 'wait';
    };
    const onCancel = () => {
      if (axis === 'swipe') release();
      start = null;
      axis = 'wait';
    };
    root.addEventListener('touchstart', onStart, { passive: true });
    root.addEventListener('touchmove', onMove, { passive: true });
    root.addEventListener('touchend', onEnd);
    root.addEventListener('touchcancel', onCancel);
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onCancel);
      release();
    };
  }, [enabled, open, setOpen, surface, sheet]);
}
