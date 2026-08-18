import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import {
  navSectionSignal,
  currentSpaceCanonicalIdSignal,
  currentSpaceIdSignal,
  currentSpaceViewModeSignal,
  currentSpaceTaskIdSignal,
  currentSpaceSessionIdSignal,
  type NavSection,
} from '../lib/signals.ts';
import {
  navigateToSessions,
  navigateToSettings,
  navigateToSpaces,
  navigateToSpace,
  navigateToSpaceTasks,
  navigateToSpaceSessions,
  navigateToSpaceAgent,
  navigateToSpaceConfigure,
} from '../lib/router.ts';
import { spaceStore } from '../lib/space-store';
import { isActionRequired, isActiveTask } from '../lib/task-filters';

interface TabItem {
  id:
    | NavSection
    | 'space-overview'
    | 'space-tasks'
    | 'space-sessions'
    | 'space-agent'
    | 'space-settings';
  label: string;
  icon: () => JSX.Element;
}

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

const ChatsIcon = () => (
  <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
    />
  </svg>
);

const SettingsIcon = () => (
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

const SpaceSessionsIcon = () => (
  <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
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

const SPACE_BOTTOM_TABS: TabItem[] = [
  { id: 'space-overview', label: 'Overview', icon: SpaceOverviewIcon },
  { id: 'space-tasks', label: 'Tasks', icon: SpaceTasksIcon },
  { id: 'space-sessions', label: 'Sessions', icon: SpaceSessionsIcon },
  { id: 'space-agent', label: 'Agents', icon: SpaceChatIcon },
  { id: 'space-settings', label: 'Settings', icon: SpaceSettingsIcon },
];

const GLOBAL_BOTTOM_TABS: TabItem[] = [
  { id: 'spaces', label: 'Spaces', icon: SpacesIcon },
  { id: 'chats', label: 'Chats', icon: ChatsIcon },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

const BOTTOM_BAR_HEIGHT = 53;

export function BottomTabBar({ inline }: { inline?: boolean } = {}) {
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');

    const updateHeight = () => {
      document.documentElement.style.setProperty(
        '--bottom-bar-height',
        mq.matches ? BOTTOM_BAR_HEIGHT + 'px' : '0px'
      );
    };

    updateHeight();
    mq.addEventListener('change', updateHeight);

    return () => {
      mq.removeEventListener('change', updateHeight);
      document.documentElement.style.setProperty('--bottom-bar-height', '0px');
    };
  }, []);

  const navSection = navSectionSignal.value;
  const spaceId = currentSpaceIdSignal.value;
  const canonicalSpaceId = currentSpaceCanonicalIdSignal.value;

  const isInSpaceContext = navSection === 'spaces' && spaceId !== null;

  const spaceViewMode = currentSpaceViewModeSignal.value;
  const spaceTaskId = currentSpaceTaskIdSignal.value;
  const spaceSessionId = currentSpaceSessionIdSignal.value;

  const tasks = spaceStore.tasks.value;
  const actionCount = tasks.filter(isActionRequired).length;
  const activeCount = tasks.filter(isActiveTask).length;

  const tabs = isInSpaceContext ? SPACE_BOTTOM_TABS : GLOBAL_BOTTOM_TABS;

  const handleTabClick = (id: TabItem['id']) => {
    switch (id) {
      case 'spaces':
        navigateToSpaces();
        break;
      case 'chats':
        navigateToSessions();
        break;
      case 'settings':
        navigateToSettings();
        break;
      case 'space-overview':
        if (spaceId) navigateToSpace(spaceId);
        break;
      case 'space-tasks':
        if (spaceId)
          navigateToSpaceTasks(spaceId, actionCount === 0 && activeCount > 0 ? 'active' : 'action');
        break;
      case 'space-sessions':
        if (spaceId) navigateToSpaceSessions(spaceId);
        break;
      case 'space-agent':
        if (spaceId) navigateToSpaceAgent(spaceId);
        break;
      case 'space-settings':
        if (spaceId) navigateToSpaceConfigure(spaceId);
        break;
    }
  };

  const isTabActive = (id: TabItem['id']): boolean => {
    if (isInSpaceContext) {
      const routeSpaceIds = [spaceId, canonicalSpaceId].filter((id): id is string => id !== null);
      const isSpaceAgentSession = routeSpaceIds.some((id) => spaceSessionId === `space:chat:${id}`);
      const isLongHorizonAgentSession =
        spaceSessionId !== null &&
        (spaceSessionId.startsWith('space:agent:') ||
          spaceStore.longHorizonAgents.value.some((agent) => agent.sessionId === spaceSessionId));

      if (id === 'space-settings') return spaceViewMode === 'configure';
      if (id === 'space-sessions')
        return (
          spaceViewMode === 'sessions' ||
          (!!spaceSessionId && !isSpaceAgentSession && !isLongHorizonAgentSession)
        );
      if (id === 'space-agent')
        return spaceViewMode === 'agents' || isSpaceAgentSession || isLongHorizonAgentSession;
      if (id === 'space-tasks') return spaceViewMode === 'tasks' || spaceTaskId !== null;
      if (id === 'space-overview')
        return spaceViewMode === 'overview' && spaceTaskId === null && spaceSessionId === null;
    }
    return navSection === id;
  };

  return (
    <div
      data-testid="bottom-tab-bar"
      class={
        inline
          ? 'flex md:hidden flex-shrink-0 bg-dark-900/90 backdrop-blur-md pb-safe'
          : 'flex md:hidden fixed bottom-0 left-0 right-0 z-50 bg-dark-900/90 backdrop-blur-md pb-safe'
      }
      role="tablist"
      aria-label={isInSpaceContext ? 'Space navigation' : 'Main navigation'}
    >
      <div
        class="flex w-full border-t border-dark-700 transition-opacity duration-200 ease-out"
        style={{ height: BOTTOM_BAR_HEIGHT + 'px' }}
        key={isInSpaceContext ? 'space' : 'global'}
      >
        {tabs.map((tab) => {
          const isActive = isTabActive(tab.id);

          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-label={tab.label}
              onClick={() => handleTabClick(tab.id)}
              class={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 transition-colors duration-150 ${
                isActive ? 'text-indigo-400' : 'text-gray-400 active:text-gray-300'
              }`}
            >
              <tab.icon />
              <span class="text-[10px] font-medium leading-none">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
