import type { ComponentChildren } from 'preact';
import { Suspense } from 'preact/compat';
import { SpacePageHeader } from './SpacePageHeader';

export const GLASS_SURFACE =
  'border-white/15 bg-white/[0.07] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_16px_40px_rgba(0,0,0,0.18)] backdrop-blur-xl';

export const FLAT_SURFACE =
  'border-white/15 bg-dark-900/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_18px_44px_rgba(0,0,0,0.24)]';

export const GLASS_ROUTE_SHELL_CLASS =
  'relative isolate flex-1 flex flex-col overflow-hidden bg-app-content before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(circle_at_8%_0%,rgba(142,79,100,0.22),transparent_34%),radial-gradient(circle_at_95%_10%,rgba(42,91,119,0.18),transparent_39%),radial-gradient(circle_at_54%_112%,rgba(77,68,151,0.22),transparent_49%)] after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:bg-[linear-gradient(180deg,rgba(12,15,22,0.02),rgba(8,11,18,0.22))]';

export const GLASS_CONTENT_CONTAINER_CLASS =
  'mx-auto w-full max-w-6xl px-4 pb-10 pt-2 sm:px-8 sm:pt-4';

export const GLASS_PRIMARY_BUTTON_CLASS =
  'inline-flex h-10 shrink-0 items-center justify-center rounded-xl bg-amber-300 px-4 text-sm font-semibold text-dark-950 shadow-[0_10px_24px_rgba(252,211,77,0.16)] transition hover:-translate-y-0.5 hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/70';

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
