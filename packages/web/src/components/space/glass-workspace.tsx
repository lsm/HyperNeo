import type { ComponentChildren, VNode } from 'preact';
import { cloneElement } from 'preact';
import { Suspense } from 'preact/compat';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { SpacePageHeader } from './SpacePageHeader';

type GlassSurfaceKey =
  | 'overview'
  | 'agents'
  | 'goals'
  | 'memories'
  | 'forge'
  | 'tasks'
  | 'sessions';

interface GlassRouteShellProps {
  pageTitle: string;
  subtitle?: string;
  appearance?: 'default' | 'hero';
  surfaceKey: GlassSurfaceKey;
  testId: string;
  baseLayerProps?: { inert?: boolean; 'aria-hidden'?: boolean };
  fallback?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
}

export function GlassRouteShell({
  pageTitle,
  subtitle,
  appearance,
  surfaceKey,
  testId,
  baseLayerProps = {},
  fallback = null,
  actions,
  children,
}: GlassRouteShellProps) {
  return (
    <div
      class="glass-route-shell"
      data-testid={testId}
      {...{ [`data-${surfaceKey}-surface`]: 'glass-workspace' }}
      {...baseLayerProps}
    >
      <SpacePageHeader
        pageTitle={pageTitle}
        subtitle={subtitle}
        appearance={appearance}
        actions={actions}
      />
      <div class="flex-1 min-w-0 overflow-hidden flex flex-col">
        <Suspense fallback={fallback}>{children}</Suspense>
      </div>
    </div>
  );
}

/**
 * Glass pill strip for tab navigation. Fills the remaining column width and
 * swipes horizontally (scrollbar hidden) — pills never wrap or squeeze their
 * labels onto two lines. Mount inside a GlassTabStrip to get scroll chevrons.
 */
export const GLASS_TAB_STRIP_CLASS =
  'glass-surface scrollbar-none flex min-w-0 flex-1 gap-1 overflow-x-auto rounded-xl p-1.5';

/** Pill inside a GLASS_TAB_STRIP_CLASS strip — single line, accent when active. */
export const GLASS_TAB_PILL_CLASS =
  'flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition';

function TabStripArrow({ dir, onClick }: { dir: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir === 'left' ? 'Scroll tabs left' : 'Scroll tabs right'}
      class="flex h-7 w-7 items-center justify-center rounded-full border border-line-strong bg-surface-raised text-fg-muted shadow-md transition hover:text-fg-soft"
    >
      <svg
        class="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d={dir === 'left' ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'}
        />
      </svg>
    </button>
  );
}

/**
 * Scroll chevrons around an overflowing glass tab strip.
 *
 * Wraps exactly one strip element (e.g. a TabList or a role="tablist" div
 * carrying GLASS_TAB_STRIP_CLASS) and overlays a small round arrow whenever
 * that direction has hidden content — the affordance that the strip scrolls,
 * plus click-to-scroll for pointer users who can't swipe. Arrows vanish at
 * the strip's ends and when everything fits. Touch-primary devices (phones/
 * tablets) never get arrows: swiping is the native gesture there, and
 * `(hover: hover) and (pointer: fine)` is the browser's signal for a mouse/
 * trackpad-driven environment. Restyle call sites, not this component.
 */
export function GlassTabStrip({ children }: { children: ComponentChildren }) {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  // Pointer-only environments need click-to-scroll; touch devices swipe.
  const [showArrows] = useState(
    () => window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true
  );

  const sync = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanLeft(el.scrollLeft > 4 && max > 4);
    setCanRight(el.scrollLeft < max - 4);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    // Pills and dirty dots come and go; keep the arrows honest about overflow.
    const mo = new MutationObserver(sync);
    mo.observe(el, { childList: true, subtree: true, attributes: true });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(sync);
      ro.observe(el);
    }
    return () => {
      el.removeEventListener('scroll', sync);
      mo.disconnect();
      ro?.disconnect();
    };
  }, [sync]);

  const scrollByDir = (dir: 1 | -1) => () => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.75, 120), behavior: 'smooth' });
  };

  const child = (Array.isArray(children) ? children[0] : children) as VNode;
  // Arrows OVERLAY the strip edges rather than sitting in flow — in-flow
  // buttons would change the scroller's width as they appear/disappear and
  // clamp scrolls short of the true end. Overlaid, the strip's geometry never
  // shifts, and strips that fit (wide desktop) render no arrows at all.
  return (
    <div class="relative mt-1 w-full self-start sm:w-auto">
      {cloneElement(child, { ref: scrollerRef })}
      {showArrows && canLeft && (
        <div class="absolute inset-y-1 left-1 z-10 flex items-center">
          <TabStripArrow dir="left" onClick={scrollByDir(-1)} />
        </div>
      )}
      {showArrows && canRight && (
        <div class="absolute inset-y-1 right-1 z-10 flex items-center">
          <TabStripArrow dir="right" onClick={scrollByDir(1)} />
        </div>
      )}
    </div>
  );
}
