import {
  createSpaceAgentPath,
  createSpaceConfigurePath,
  createSpaceEvolvePath,
  createSpaceGoalsPath,
  createSpaceMemoriesPath,
  createSpacePath,
  createSpaceSessionPath,
  createSpaceTaskPath,
  createSpaceTasksPath,
  navigateToSpace,
  navigateToSpaceAgent,
  navigateToSpaceConfigure,
  navigateToSpaceEvolve,
  navigateToSpaceGoals,
  navigateToSpaceMemories,
  navigateToSpaceSession,
  navigateToSpacesPage,
  navigateToSpaceTask,
  navigateToSpaceTasks,
} from './space-router.ts';
import { navSectionSignal } from './signals.ts';
import {
  currentSpaceAgentHandleSignal,
  currentSpaceIdSignal,
  currentSpaceSessionIdSignal,
  currentSpaceSettingsTabSignal,
  currentSpaceTaskIdSignal,
  currentSpaceTasksFilterTabSignal,
  currentSpaceViewModeSignal,
  type SpaceSettingsTab,
  type SpaceTasksFilterTab,
  type SpaceViewMode,
} from './space-signals.ts';
import type { ExtensionRoute } from './web-extensions.ts';

export interface SpaceRouteState {
  spaceId: string | null;
  spaceSessionId: string | null;
  spaceTaskId: string | null;
  spaceAgentHandle: string | null;
  spaceViewMode: SpaceViewMode;
  spaceConfigureTab: SpaceSettingsTab;
  spaceTasksFilterTab: SpaceTasksFilterTab;
  navSection: string;
}

export function deriveSpaceRoute(state: SpaceRouteState): ExtensionRoute | null {
  const { spaceId, spaceSessionId, spaceTaskId, spaceAgentHandle, spaceViewMode } = state;
  const { spaceConfigureTab, spaceTasksFilterTab, navSection } = state;
  if (!spaceId) {
    return navSection === 'spaces'
      ? { path: '/spaces', open: () => navigateToSpacesPage(true) }
      : null;
  }
  if (spaceTaskId) {
    return {
      path: createSpaceTaskPath(spaceId, spaceTaskId),
      open: () => navigateToSpaceTask(spaceId, spaceTaskId, true),
    };
  }
  if (spaceViewMode === 'agents') {
    return {
      path: createSpaceAgentPath(spaceId, spaceAgentHandle ?? undefined),
      open: () => navigateToSpaceAgent(spaceId, spaceAgentHandle ?? true, true),
    };
  }
  if (spaceSessionId) {
    return {
      path: createSpaceSessionPath(spaceId, spaceSessionId),
      open: () => navigateToSpaceSession(spaceId, spaceSessionId, true),
    };
  }
  if (spaceViewMode === 'goals') {
    return {
      path: createSpaceGoalsPath(spaceId),
      open: () => navigateToSpaceGoals(spaceId, true),
    };
  }
  if (spaceViewMode === 'memories') {
    return {
      path: createSpaceMemoriesPath(spaceId),
      open: () => navigateToSpaceMemories(spaceId, true),
    };
  }
  if (spaceViewMode === 'forge') {
    return {
      path: createSpaceEvolvePath(spaceId),
      open: () => navigateToSpaceEvolve(spaceId, true),
    };
  }
  if (spaceViewMode === 'tasks') {
    return {
      path: createSpaceTasksPath(
        spaceId,
        spaceTasksFilterTab !== 'active' ? spaceTasksFilterTab : undefined
      ),
      open: () => navigateToSpaceTasks(spaceId, undefined, true),
    };
  }
  if (spaceViewMode === 'configure') {
    return {
      path: createSpaceConfigurePath(spaceId, spaceConfigureTab),
      open: () =>
        navigateToSpaceConfigure(
          spaceId,
          spaceConfigureTab !== 'general' ? spaceConfigureTab : undefined,
          true
        ),
    };
  }
  return { path: createSpacePath(spaceId), open: () => navigateToSpace(spaceId, true) };
}

export function spaceCurrentRoute(): ExtensionRoute | null {
  return deriveSpaceRoute({
    spaceId: currentSpaceIdSignal.value,
    spaceSessionId: currentSpaceSessionIdSignal.value,
    spaceTaskId: currentSpaceTaskIdSignal.value,
    spaceAgentHandle: currentSpaceAgentHandleSignal.value,
    spaceViewMode: currentSpaceViewModeSignal.value,
    spaceConfigureTab: currentSpaceSettingsTabSignal.value,
    spaceTasksFilterTab: currentSpaceTasksFilterTabSignal.value,
    navSection: navSectionSignal.value,
  });
}
