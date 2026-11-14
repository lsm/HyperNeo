import type { ComponentChildren } from 'preact';
import { Suspense } from 'preact/compat';
import { SpacePageHeader } from './SpacePageHeader';

type GlassSurfaceKey = 'overview' | 'agents' | 'goals' | 'memories' | 'forge' | 'tasks';

interface GlassRouteShellProps {
  pageTitle: string;
  surfaceKey: GlassSurfaceKey;
  testId: string;
  baseLayerProps?: { inert?: boolean; 'aria-hidden'?: boolean };
  fallback?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
}

export function GlassRouteShell({
  pageTitle,
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
      <SpacePageHeader pageTitle={pageTitle} actions={actions} />
      <div class="flex-1 min-w-0 overflow-hidden flex flex-col">
        <Suspense fallback={fallback}>{children}</Suspense>
      </div>
    </div>
  );
}
