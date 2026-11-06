import type { ComponentChild } from 'preact';
import { lazy, Suspense } from 'preact/compat';
import { SpacesHome } from './SpacesHome.tsx';
import {
  currentSpaceCanonicalIdSignal,
  currentSpaceIdSignal,
  currentSpaceSessionIdSignal,
  currentSpaceTaskIdSignal,
  currentSpaceViewModeSignal,
} from '../../lib/space-signals.ts';

const SpaceIsland = lazy(() => import('./SpaceIsland.tsx'));

export function SpaceMain({ fallback }: { fallback: ComponentChild }) {
  const routeSpaceId = currentSpaceIdSignal.value;
  const spaceId = currentSpaceCanonicalIdSignal.value ?? routeSpaceId;
  if (!spaceId) return <SpacesHome />;
  return (
    <Suspense fallback={fallback}>
      <SpaceIsland
        spaceId={spaceId}
        routeSpaceId={routeSpaceId}
        viewMode={currentSpaceViewModeSignal.value}
        sessionViewId={currentSpaceSessionIdSignal.value}
        taskViewId={currentSpaceTaskIdSignal.value}
      />
    </Suspense>
  );
}
