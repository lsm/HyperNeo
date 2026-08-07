/**
 * Pure derivation of the URL the app expects for the current navigation state.
 *
 * Extracted from App.tsx's URL-sync effect so the per-view-mode branching is
 * unit-testable without mounting the whole app (the component tests mock the
 * store, which is how a missing view-mode branch previously slipped through).
 *
 * Keep this in sync with the navigation dispatch in App.tsx: every view mode
 * that produces an `expectedPath` here must also have a matching navigate
 * branch there, and vice versa.
 */

import {
  createSessionPath,
  createSpacePath,
  createSpaceAgentPath,
  createSpaceConfigurePath,
  createSpaceForgePath,
  createSpaceGoalsPath,
  createSpaceMemoriesPath,
  createSpaceSessionPath,
  createSpaceSessionsPath,
  createSpaceTaskPath,
  createSpaceTasksPath,
} from './router';
import type { SpaceViewMode } from './signals';

export interface AppRoutingState {
  sessionId: string | null;
  spaceId: string | null;
  spaceSessionId: string | null;
  spaceTaskId: string | null;
  spaceAgentHandle: string | null;
  spaceViewMode: SpaceViewMode;
  spaceConfigureTab: string;
  spaceTasksFilterTab: string;
  spaceTaskViewTab: string;
  navSection: string;
}

export function deriveAppExpectedPath(state: AppRoutingState): string {
  const {
    sessionId,
    spaceId,
    spaceSessionId,
    spaceTaskId,
    spaceAgentHandle,
    spaceViewMode,
    spaceConfigureTab,
    spaceTasksFilterTab,
    spaceTaskViewTab,
    navSection,
  } = state;

  if (sessionId) return createSessionPath(sessionId);
  if (spaceTaskId && spaceId) {
    return createSpaceTaskPath(
      spaceId,
      spaceTaskId,
      spaceTaskViewTab !== 'thread' ? spaceTaskViewTab : undefined
    );
  }
  if (spaceId && spaceViewMode === 'agents') {
    return createSpaceAgentPath(spaceId, spaceAgentHandle ?? undefined);
  }
  if (spaceSessionId && spaceId) return createSpaceSessionPath(spaceId, spaceSessionId);
  if (spaceId && spaceViewMode === 'sessions') return createSpaceSessionsPath(spaceId);
  if (spaceId && spaceViewMode === 'goals') return createSpaceGoalsPath(spaceId);
  if (spaceId && spaceViewMode === 'memories') return createSpaceMemoriesPath(spaceId);
  if (spaceId && spaceViewMode === 'forge') return createSpaceForgePath(spaceId);
  if (spaceId && spaceViewMode === 'tasks') {
    return createSpaceTasksPath(
      spaceId,
      spaceTasksFilterTab !== 'active' ? spaceTasksFilterTab : undefined
    );
  }
  if (spaceId && spaceViewMode === 'configure') {
    return createSpaceConfigurePath(
      spaceId,
      spaceConfigureTab !== 'agents' ? spaceConfigureTab : undefined
    );
  }
  if (spaceId) return createSpacePath(spaceId);
  if (navSection === 'chats') return '/sessions';
  if (navSection === 'settings') return '/settings';
  return '/spaces';
}
