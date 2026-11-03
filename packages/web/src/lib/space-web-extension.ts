import { lazy } from 'preact/compat';
import { GoalDetailPanel } from '../components/space/GoalDetailPanel.tsx';
import { ScopeDetailPanel } from '../components/space/ScopeDetailPanel.tsx';
import { SpaceCreateDialog } from '../components/space/SpaceCreateDialog.tsx';
import { SpaceDetailPanel } from '../islands/SpaceDetailPanel.tsx';
import { SpacesHome } from '../islands/SpacesHome.tsx';
import { spaceStore } from './space-store.ts';
import type { SpaceWebExtension } from './web-extensions.ts';

export const spaceWebExtension: SpaceWebExtension = {
  store: spaceStore,
  SpaceIsland: lazy(() => import('../islands/SpaceIsland.tsx')),
  SpaceDetailPanel,
  SpacesHome,
  SpaceCreateDialog,
  GoalDetailPanel,
  ScopeDetailPanel,
};
