import { navSectionSignal } from '../../lib/signals.ts';
import {
  currentSpaceCanonicalIdSignal,
  currentSpaceIdSignal,
  currentSpaceSessionIdSignal,
  currentSpaceTaskIdSignal,
  currentSpaceViewModeSignal,
  spaceOverlayPendingAgentNameSignal,
  spaceOverlaySessionIdSignal,
} from '../../lib/space-signals.ts';
import {
  clearOverlaySignals,
  closeOverlayHistory,
  createSpaceSessionPath,
  createSpaceTaskPath,
  navigateToSpace,
  navigateToSpaceAgent,
  navigateToSpaceConfigure,
  navigateToSpaces,
  navigateToSpaceSession,
  navigateToSpaceTask,
  navigateToSpaceTasks,
} from '../../lib/space-router.ts';
import { spaceCurrentRoute } from '../../lib/space-route-sync.ts';
import { voiceReturnTaskTargetSessionSignal } from '../../lib/voice/voice-composer-registry.ts';
import {
  openSpaceSearchResult,
  spacePaletteItems,
  spacePaletteSource,
  warmSpacePalette,
} from './space-palette.tsx';
import { isActionRequired, isActiveTask } from '../../lib/space-task-filters.ts';
import { type ExtensionNav, webExtension } from '../../lib/web-extensions.ts';

const SpacesIcon = () => (
  <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
    />
  </svg>
);

const SpaceOverviewIcon = () => (
  <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
    />
  </svg>
);

const SpaceTasksIcon = () => (
  <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
    />
  </svg>
);

const SpaceChatIcon = () => (
  <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
    />
  </svg>
);

const SpaceSettingsIcon = () => (
  <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
    />
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
    />
  </svg>
);

function spaceContextTabs(): ReturnType<ExtensionNav['contextTabs']> {
  const spaceId = currentSpaceIdSignal.value;
  if (navSectionSignal.value !== 'spaces' || spaceId === null) return null;

  const viewMode = currentSpaceViewModeSignal.value;
  const taskId = currentSpaceTaskIdSignal.value;
  const sessionId = currentSpaceSessionIdSignal.value;
  const tasks = webExtension('space')?.store.tasks.value ?? [];
  const actionCount = tasks.filter(isActionRequired).length;
  const activeCount = tasks.filter(isActiveTask).length;

  return {
    label: 'Space navigation',
    tabs: [
      {
        id: 'space-overview',
        label: 'Overview',
        icon: SpaceOverviewIcon,
        active: viewMode === 'overview' && taskId === null && sessionId === null,
        open: () => navigateToSpace(spaceId),
      },
      {
        id: 'space-tasks',
        label: 'Tasks',
        icon: SpaceTasksIcon,
        active: viewMode === 'tasks' || taskId !== null,
        open: () =>
          navigateToSpaceTasks(spaceId, actionCount === 0 && activeCount > 0 ? 'active' : 'action'),
      },
      {
        id: 'space-agent',
        label: 'Agents',
        icon: SpaceChatIcon,
        active: viewMode === 'agents' || sessionId !== null,
        open: () => navigateToSpaceAgent(spaceId),
      },
      {
        id: 'space-settings',
        label: 'Settings',
        icon: SpaceSettingsIcon,
        active: viewMode === 'configure',
        open: () => navigateToSpaceConfigure(spaceId),
      },
    ],
  };
}

const SPACE_SCOPE_PREFIX = 'space:';

export function spaceVoiceScope(spaceId: string | null): string | null {
  return spaceId ? `${SPACE_SCOPE_PREFIX}${spaceId}` : null;
}

function spaceSessionFocus(): ReturnType<ExtensionNav['sessionFocus']> {
  const overlaySessionId = spaceOverlaySessionIdSignal.value;
  const overlayPending = spaceOverlayPendingAgentNameSignal.value !== null;
  const overlayOpen = overlaySessionId !== null || overlayPending;
  const sessionId = overlaySessionId ?? (overlayPending ? null : currentSpaceSessionIdSignal.value);
  return overlayOpen || sessionId !== null
    ? {
        overlayOpen,
        overlaySessionId,
        sessionId,
        closeOverlay: closeOverlayHistory,
        clearOverlay: clearOverlaySignals,
      }
    : null;
}

function spaceRecordingReturn(
  scopeId: string,
  sessionId: string,
  taskId: string | null
): ReturnType<ExtensionNav['recordingReturn']> {
  if (!scopeId.startsWith(SPACE_SCOPE_PREFIX)) return null;
  const spaceId = scopeId.slice(SPACE_SCOPE_PREFIX.length);
  if (taskId === null)
    return {
      path: createSpaceSessionPath(spaceId, sessionId),
      open: (replace) => navigateToSpaceSession(spaceId, sessionId, replace),
    };
  return {
    path: createSpaceTaskPath(spaceId, taskId),
    open: (replace) => {
      voiceReturnTaskTargetSessionSignal.value = sessionId;
      navigateToSpaceTask(spaceId, taskId, replace);
    },
  };
}

function spaceContentKey(): string | null {
  const spaceId = currentSpaceIdSignal.value;
  if (spaceId) return `space-${spaceId}-${currentSpaceViewModeSignal.value}`;
  return navSectionSignal.value === 'spaces' ? 'spaces' : null;
}

export const spaceNav: ExtensionNav = {
  extension: 'space',
  section: 'spaces',
  label: 'Spaces',
  icon: SpacesIcon,
  open: () => navigateToSpaces(),
  contextTabs: spaceContextTabs,
  contentKey: spaceContentKey,
  currentRoute: spaceCurrentRoute,
  holdsSessionSelection: () => currentSpaceSessionIdSignal.value !== null,
  voiceScope: () =>
    spaceVoiceScope(currentSpaceCanonicalIdSignal.value ?? currentSpaceIdSignal.value),
  paletteItems: spacePaletteItems,
  paletteSource: spacePaletteSource,
  warmPalette: warmSpacePalette,
  openSearchResult: openSpaceSearchResult,
  sessionFocus: spaceSessionFocus,
  recordingReturn: spaceRecordingReturn,
};
