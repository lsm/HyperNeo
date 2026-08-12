/**
 * Glass Workspace — shared visual system for the Space middle column.
 *
 * Single source of truth for the surface materials, atmospheric route shell,
 * content container, and primary-action styling used by the Overview, Agents,
 * Goals, and Memories routes. Import these instead of redefining them per page
 * so the four routes cannot drift apart (the Goals treatment is canonical).
 *
 * The atmospheric radial-gradient values here are the canonical "Goals" values;
 * every Glass Workspace route renders this exact background via GlassRouteShell.
 */

import type { ComponentChildren } from 'preact';
import { Suspense } from 'preact/compat';
import { SpacePageHeader } from './SpacePageHeader';

/** Translucent frosted surface — summary cards, control strips, search fields. */
export const GLASS_SURFACE =
  'border-white/15 bg-white/[0.07] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_16px_40px_rgba(0,0,0,0.18)] backdrop-blur-xl';

/** Opaque high-contrast surface — content cards, list rows, state panels. */
export const FLAT_SURFACE =
  'border-white/15 bg-dark-900/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_18px_44px_rgba(0,0,0,0.24)]';

/**
 * Atmospheric route shell — the contained radial "spot light" gradients plus a
 * subtle top-to-bottom darkening overlay. Canonical Goals values; applied to
 * every Glass Workspace route via GlassRouteShell so the background never drifts.
 *
 * NOTE: keep this single-line with underscores (no spaces/newlines inside the
 * arbitrary values) — Tailwind only extracts the utility when the class candidate
 * is contiguous. Multi-line/space-split versions silently fail to generate.
 */
export const GLASS_ROUTE_SHELL_CLASS =
  'relative isolate flex-1 flex flex-col overflow-hidden bg-app-content before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(circle_at_8%_0%,rgba(142,79,100,0.22),transparent_34%),radial-gradient(circle_at_95%_10%,rgba(42,91,119,0.18),transparent_39%),radial-gradient(circle_at_54%_112%,rgba(77,68,151,0.22),transparent_49%)] after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:bg-[linear-gradient(180deg,rgba(12,15,22,0.02),rgba(8,11,18,0.22))]';

/** Centered scrollable content column used inside the shell. */
export const GLASS_CONTENT_CONTAINER_CLASS =
  'mx-auto w-full max-w-6xl px-4 pb-10 pt-2 sm:px-8 sm:pt-4';

/** Amber primary action (Create goal / New Memory / …). */
export const GLASS_PRIMARY_BUTTON_CLASS =
  'inline-flex h-10 shrink-0 items-center justify-center rounded-xl bg-amber-300 px-4 text-sm font-semibold text-dark-950 shadow-[0_10px_24px_rgba(252,211,77,0.16)] transition hover:-translate-y-0.5 hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/70';

type GlassSurfaceKey = 'overview' | 'agents' | 'goals' | 'memories' | 'forge' | 'tasks';

interface GlassRouteShellProps {
  pageTitle: string;
  subtitle?: string;
  appearance?: 'default' | 'hero';
  /** Which route — drives the `data-{key}-surface="glass-workspace"` marker. */
  surfaceKey: GlassSurfaceKey;
  /** The route's `data-testid` (e.g. "space-goals-view"). */
  testId: string;
  /** Inert/aria-hidden overlay state from SpaceIsland; spread onto the shell. */
  baseLayerProps?: { inert?: boolean; 'aria-hidden'?: boolean };
  /** Suspense fallback while the route's lazy body loads. */
  fallback?: ComponentChildren;
  /** Optional header actions (e.g. a create button) forwarded to SpacePageHeader. */
  actions?: ComponentChildren;
  children: ComponentChildren;
}

/**
 * Atmospheric route shell shared by the Glass Workspace routes. Renders the
 * canonical background, the SpacePageHeader (hero for content routes, subtitle
 * for Overview), and a Suspense-wrapped body slot. `{overlay}` stays outside
 * this component — callers compose it as a sibling to preserve stacking order.
 */
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
      class={GLASS_ROUTE_SHELL_CLASS}
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
