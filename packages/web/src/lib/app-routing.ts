import {
  createSessionPath,
  createSpacePath,
  createSpaceAgentPath,
  createSpaceConfigurePath,
  createSpaceEvolvePath,
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
  if (spaceId && spaceViewMode === 'forge') return createSpaceEvolvePath(spaceId);
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
