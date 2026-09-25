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

export const GLASS_TAB_STRIP_CLASS =
  'glass-surface scrollbar-none flex min-w-0 flex-1 gap-1 overflow-x-auto rounded-xl p-1.5';

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

export function GlassTabStrip({ children }: { children: ComponentChildren }) {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
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
