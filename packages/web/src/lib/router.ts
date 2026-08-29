import { batch } from '@preact/signals';
import {
  currentSessionIdSignal,
  currentSpaceAgentHandleSignal,
  currentSpaceCanonicalIdSignal,
  currentSpaceConfigureTabSignal,
  currentSpaceIdSignal,
  currentSpaceSessionIdSignal,
  currentSpaceTaskIdSignal,
  currentSpaceTasksFilterTabSignal,
  currentSpaceTaskViewTabSignal,
  currentSpaceViewModeSignal,
  navSectionSignal,
  type SettingsSection,
  type SpaceOverlayTaskContext,
  type SpaceTaskViewTab,
  settingsSectionSignal,
  spaceOverlayAgentNameSignal,
  spaceOverlayHighlightMessageIdSignal,
  spaceOverlayPendingAgentNameSignal,
  spaceOverlayPendingTaskIdSignal,
  spaceOverlaySessionIdSignal,
  spaceOverlayTaskContextSignal,
} from './signals.ts';

const SESSION_ROUTE_PATTERN = /^\/session\/([a-f0-9-]+)$/i;
const SESSIONS_ROUTE_PATTERN = /^\/sessions$/;
const SPACES_ROUTE_PATTERN = /^\/spaces$/;
const SETTINGS_ROUTE_PATTERN = /^\/settings$/;
const SPACE_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)$/;
const SPACE_CONFIGURE_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/configure$/;
const SPACE_CONFIGURE_TAB_ROUTE_PATTERN =
  /^\/space\/([a-z0-9-]+)\/configure\/(agents|workflows|settings)$/;
const SPACE_GOALS_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/goals$/;
const SPACE_MEMORIES_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/memories$/;
const SPACE_EVOLVE_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/evolve$/;
const SPACE_FORGE_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/forge$/;
const SPACE_TASKS_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/tasks$/;
const SPACE_TASKS_ARCHIVED_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/tasks\/archived$/;
const SPACE_TASKS_TAB_ROUTE_PATTERN =
  /^\/space\/([a-z0-9-]+)\/tasks\/(action|active|draft|completed|scheduled)$/;
const SPACE_AGENT_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/(?:agent|agents)$/;
const SPACE_AGENT_DETAIL_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/agent\/([a-z0-9-]+)$/;
const SPACE_SESSION_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/session\/([a-zA-Z0-9:_-]+)$/;
const SPACE_TASK_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/task\/([a-fA-F0-9-]+|[a-z]-[1-9]\d*)$/;
const SPACE_TASK_VIEW_ROUTE_PATTERN =
  /^\/space\/([a-z0-9-]+)\/task\/([a-fA-F0-9-]+|[a-z]-[1-9]\d*)\/(thread|timeline|log|canvas|artifacts)$/;
const SPACE_SESSIONS_ROUTE_PATTERN = /^\/space\/([a-z0-9-]+)\/sessions$/;
const SETTINGS_SECTIONS = new Set<SettingsSection>([
  'general',
  'appearance',
  'providers',
  'voice',
  'app-mcp-servers',
  'skills',
  'models',
  'usage',
  'shortcuts',
  'about',
]);

interface RouterState {
  isInitialized: boolean;
  isNavigating: boolean;
}

const routerState: RouterState = {
  isInitialized: false,
  isNavigating: false,
};

const IN_APP_HISTORY_DEPTH_KEY = '__hyperneoInAppHistoryDepth';

function getInAppHistoryDepth(state = window.history.state): number {
  if (!state || typeof state !== 'object') return 0;
  const depth = (state as Record<string, unknown>)[IN_APP_HISTORY_DEPTH_KEY];
  return typeof depth === 'number' && Number.isFinite(depth) ? Math.max(0, depth) : 0;
}

export function getSessionIdFromPath(path: string): string | null {
  const match = path.match(SESSION_ROUTE_PATTERN);
  return match ? match[1] : null;
}

export function getSpaceIdFromPath(path: string): string | null {
  const configureTabMatch = path.match(SPACE_CONFIGURE_TAB_ROUTE_PATTERN);
  if (configureTabMatch) return configureTabMatch[1];

  const configureMatch = path.match(SPACE_CONFIGURE_ROUTE_PATTERN);
  if (configureMatch) return configureMatch[1];

  const archivedTasksMatch = path.match(SPACE_TASKS_ARCHIVED_ROUTE_PATTERN);
  if (archivedTasksMatch) return archivedTasksMatch[1];

  const tasksTabMatch = path.match(SPACE_TASKS_TAB_ROUTE_PATTERN);
  if (tasksTabMatch) return tasksTabMatch[1];

  const goalsMatch = path.match(SPACE_GOALS_ROUTE_PATTERN);
  if (goalsMatch) return goalsMatch[1];

  const memoriesMatch = path.match(SPACE_MEMORIES_ROUTE_PATTERN);
  if (memoriesMatch) return memoriesMatch[1];

  const evolveMatch = path.match(SPACE_EVOLVE_ROUTE_PATTERN);
  if (evolveMatch) return evolveMatch[1];

  const forgeMatch = path.match(SPACE_FORGE_ROUTE_PATTERN);
  if (forgeMatch) return forgeMatch[1];

  const tasksMatch = path.match(SPACE_TASKS_ROUTE_PATTERN);
  if (tasksMatch) return tasksMatch[1];

  const sessionsMatch = path.match(SPACE_SESSIONS_ROUTE_PATTERN);
  if (sessionsMatch) return sessionsMatch[1];

  const agentDetailMatch = path.match(SPACE_AGENT_DETAIL_ROUTE_PATTERN);
  if (agentDetailMatch) return agentDetailMatch[1];

  const taskViewMatch = path.match(SPACE_TASK_VIEW_ROUTE_PATTERN);
  if (taskViewMatch) return taskViewMatch[1];

  const taskMatch = path.match(SPACE_TASK_ROUTE_PATTERN);
  if (taskMatch) return taskMatch[1];

  const sessionMatch = path.match(SPACE_SESSION_ROUTE_PATTERN);
  if (sessionMatch) return sessionMatch[1];

  const agentMatch = path.match(SPACE_AGENT_ROUTE_PATTERN);
  if (agentMatch) return agentMatch[1];

  const match = path.match(SPACE_ROUTE_PATTERN);
  return match ? match[1] : null;
}

export function getSpaceAgentFromPath(path: string): string | null {
  const detailMatch = path.match(SPACE_AGENT_DETAIL_ROUTE_PATTERN);
  if (detailMatch) return detailMatch[1];
  const match = path.match(SPACE_AGENT_ROUTE_PATTERN);
  return match ? match[1] : null;
}

export function getSpaceAgentDetailFromPath(
  path: string
): { spaceId: string; handle: string } | null {
  const match = path.match(SPACE_AGENT_DETAIL_ROUTE_PATTERN);
  if (!match) return null;
  return { spaceId: match[1], handle: match[2] };
}

export function getSpaceConfigureFromPath(path: string): string | null {
  const match = path.match(SPACE_CONFIGURE_ROUTE_PATTERN);
  return match ? match[1] : null;
}

export function getSpaceConfigureTabFromPath(
  path: string
): { spaceId: string; tab: 'agents' | 'workflows' | 'settings' } | null {
  const match = path.match(SPACE_CONFIGURE_TAB_ROUTE_PATTERN);
  if (!match) return null;
  return { spaceId: match[1], tab: match[2] as 'agents' | 'workflows' | 'settings' };
}

export function getSpaceGoalsFromPath(path: string): string | null {
  const match = path.match(SPACE_GOALS_ROUTE_PATTERN);
  return match ? match[1] : null;
}

export function getSpaceMemoriesFromPath(path: string): string | null {
  const match = path.match(SPACE_MEMORIES_ROUTE_PATTERN);
  return match ? match[1] : null;
}

export function getSpaceEvolveFromPath(path: string): string | null {
  const evolveMatch = path.match(SPACE_EVOLVE_ROUTE_PATTERN);
  if (evolveMatch) return evolveMatch[1];
  const forgeMatch = path.match(SPACE_FORGE_ROUTE_PATTERN);
  return forgeMatch ? forgeMatch[1] : null;
}

export function getSpaceForgeFromPath(path: string): string | null {
  return getSpaceEvolveFromPath(path);
}

export function getSpaceTasksFromPath(path: string): string | null {
  const match = path.match(SPACE_TASKS_ROUTE_PATTERN);
  return match ? match[1] : null;
}

export function getSpaceTasksTabFromPath(path: string): {
  spaceId: string;
  tab: 'action' | 'active' | 'draft' | 'completed' | 'scheduled';
} | null {
  const archivedMatch = path.match(SPACE_TASKS_ARCHIVED_ROUTE_PATTERN);
  if (archivedMatch) return { spaceId: archivedMatch[1], tab: 'completed' };

  const match = path.match(SPACE_TASKS_TAB_ROUTE_PATTERN);
  if (!match) return null;
  return {
    spaceId: match[1],
    tab: match[2] as 'action' | 'active' | 'draft' | 'completed' | 'scheduled',
  };
}

export function getSpaceSessionsListFromPath(path: string): string | null {
  const match = path.match(SPACE_SESSIONS_ROUTE_PATTERN);
  return match ? match[1] : null;
}

export function getSpaceSessionIdFromPath(
  path: string
): { spaceId: string; sessionId: string } | null {
  const match = path.match(SPACE_SESSION_ROUTE_PATTERN);
  if (!match) return null;
  return { spaceId: match[1], sessionId: match[2] };
}

export function getSpaceTaskIdFromPath(path: string): { spaceId: string; taskId: string } | null {
  const match = path.match(SPACE_TASK_ROUTE_PATTERN);
  if (!match) return null;
  return { spaceId: match[1], taskId: match[2] };
}

export function getSpaceTaskViewFromPath(
  path: string
): { spaceId: string; taskId: string; view: SpaceTaskViewTab } | null {
  const match = path.match(SPACE_TASK_VIEW_ROUTE_PATTERN);
  if (!match) return null;
  return {
    spaceId: match[1],
    taskId: match[2],
    view: match[3] as SpaceTaskViewTab,
  };
}

export function getCurrentPath(): string {
  return window.location.pathname;
}

function getCurrentPathWithSearch(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function getSettingsSectionFromSearch(search: string): SettingsSection {
  const section = new URLSearchParams(search).get('tab');
  if (section === 'custom-endpoints') return 'providers';
  return section && SETTINGS_SECTIONS.has(section as SettingsSection)
    ? (section as SettingsSection)
    : 'general';
}

export function createSessionPath(sessionId: string): string {
  return `/session/${sessionId}`;
}

export function createSpacePath(spaceId: string): string {
  return `/space/${spaceId}`;
}

export function createSpaceConfigurePath(spaceId: string, tab?: string): string {
  return tab ? `/space/${spaceId}/configure/${tab}` : `/space/${spaceId}/configure`;
}

export function createSpaceGoalsPath(spaceId: string): string {
  return `/space/${spaceId}/goals`;
}

export function createSpaceMemoriesPath(spaceId: string): string {
  return `/space/${spaceId}/memories`;
}

export function createSpaceEvolvePath(spaceId: string): string {
  return `/space/${spaceId}/evolve`;
}

export function createSpaceForgePath(spaceId: string): string {
  return createSpaceEvolvePath(spaceId);
}

export function createSpaceTasksPath(spaceId: string, tab?: string): string {
  return tab ? `/space/${spaceId}/tasks/${tab}` : `/space/${spaceId}/tasks`;
}

export function createSpaceSessionPath(spaceId: string, sessionId: string): string {
  return `/space/${spaceId}/session/${sessionId}`;
}

export function createSpaceTaskPath(spaceId: string, taskId: string, view?: string): string {
  return view ? `/space/${spaceId}/task/${taskId}/${view}` : `/space/${spaceId}/task/${taskId}`;
}

export function createSpaceSessionsPath(spaceId: string): string {
  return `/space/${spaceId}/sessions`;
}

export function createSpaceAgentPath(spaceId: string, handle?: string): string {
  return handle ? `/space/${spaceId}/agent/${handle}` : `/space/${spaceId}/agents`;
}

export function createSettingsPath(section?: SettingsSection): string {
  return section ? `/settings?tab=${section}` : '/settings';
}

function pushPath(path: string, state: Record<string, unknown>, replace: boolean): void {
  const historyMethod = replace ? 'replaceState' : 'pushState';
  const currentDepth = getInAppHistoryDepth();
  const nextDepth = replace ? currentDepth : currentDepth + 1;
  window.history[historyMethod](
    { ...state, path, [IN_APP_HISTORY_DEPTH_KEY]: nextDepth },
    '',
    path
  );
}

export function navigateBack(fallback: () => void): void {
  if (getInAppHistoryDepth() > 0) {
    window.history.back();
  } else {
    fallback();
  }
}

function finishNavigation(): void {
  setTimeout(() => {
    routerState.isNavigating = false;
  }, 0);
}

function clearSpaceRouteState(): void {
  currentSpaceIdSignal.value = null;
  currentSpaceCanonicalIdSignal.value = null;
  currentSpaceViewModeSignal.value = 'overview';
  currentSpaceSessionIdSignal.value = null;
  currentSpaceTaskIdSignal.value = null;
  currentSpaceTaskViewTabSignal.value = 'thread';
  currentSpaceAgentHandleSignal.value = null;
}

function setSessionRoute(sessionId: string | null): void {
  currentSessionIdSignal.value = sessionId;
  clearSpaceRouteState();
}

function setCurrentSpaceRouteId(spaceId: string): void {
  if (currentSpaceIdSignal.value !== spaceId) {
    currentSpaceCanonicalIdSignal.value = null;
  }
  currentSpaceIdSignal.value = spaceId;
}

function setSpacesListRoute(): void {
  currentSessionIdSignal.value = null;
  clearSpaceRouteState();
  navSectionSignal.value = 'spaces';
}

export function navigateToSession(sessionId: string, replace = false): void {
  if (routerState.isNavigating) return;

  const targetPath = createSessionPath(sessionId);
  if (getCurrentPath() === targetPath) {
    setSessionRoute(sessionId);
    navSectionSignal.value = 'chats';
    return;
  }

  routerState.isNavigating = true;
  try {
    pushPath(targetPath, { sessionId }, replace);
    setSessionRoute(sessionId);
    navSectionSignal.value = 'chats';
  } finally {
    finishNavigation();
  }
}

export function navigateToHome(replace = false): void {
  navigateToSpacesPage(replace);
}

export function navigateToSessions(replace = false): void {
  if (routerState.isNavigating) return;

  if (getCurrentPath() === '/sessions') {
    setSessionRoute(null);
    navSectionSignal.value = 'chats';
    return;
  }

  routerState.isNavigating = true;
  try {
    pushPath('/sessions', {}, replace);
    setSessionRoute(null);
    navSectionSignal.value = 'chats';
  } finally {
    finishNavigation();
  }
}

export function navigateToSettings(
  sectionOrReplace?: SettingsSection | boolean,
  replace = false
): void {
  if (routerState.isNavigating) return;

  const section = typeof sectionOrReplace === 'boolean' ? undefined : sectionOrReplace;
  const shouldReplace = typeof sectionOrReplace === 'boolean' ? sectionOrReplace : replace;
  const targetPath = createSettingsPath(section);
  if (getCurrentPathWithSearch() === targetPath) {
    setSessionRoute(null);
    settingsSectionSignal.value = section ?? 'general';
    navSectionSignal.value = 'settings';
    return;
  }

  routerState.isNavigating = true;
  try {
    pushPath(targetPath, { section: section ?? 'general' }, shouldReplace);
    setSessionRoute(null);
    settingsSectionSignal.value = section ?? 'general';
    navSectionSignal.value = 'settings';
  } finally {
    finishNavigation();
  }
}

export function navigateToSpaces(): void {
  navigateToSpacesPage();
}

export function isSpacesPath(path: string): boolean {
  return SPACES_ROUTE_PATTERN.test(path);
}

export function navigateToSpacesPage(replace = false): void {
  if (routerState.isNavigating) return;

  if (getCurrentPath() === '/spaces') {
    setSpacesListRoute();
    return;
  }

  routerState.isNavigating = true;
  try {
    pushPath('/spaces', {}, replace);
    setSpacesListRoute();
  } finally {
    finishNavigation();
  }
}

export function navigateToSpace(spaceId: string, replace = false): void {
  if (routerState.isNavigating) return;

  const targetPath = createSpacePath(spaceId);
  if (getCurrentPath() === targetPath) {
    setCurrentSpaceRouteId(spaceId);
    currentSpaceViewModeSignal.value = 'overview';
    currentSpaceSessionIdSignal.value = null;
    currentSpaceTaskIdSignal.value = null;
    currentSpaceTaskViewTabSignal.value = 'thread';
    currentSpaceAgentHandleSignal.value = null;
    currentSessionIdSignal.value = null;
    navSectionSignal.value = 'spaces';
    return;
  }

  routerState.isNavigating = true;
  try {
    pushPath(targetPath, { spaceId }, replace);
    setCurrentSpaceRouteId(spaceId);
    currentSpaceViewModeSignal.value = 'overview';
    currentSpaceSessionIdSignal.value = null;
    currentSpaceTaskIdSignal.value = null;
    currentSpaceTaskViewTabSignal.value = 'thread';
    currentSpaceAgentHandleSignal.value = null;
    currentSessionIdSignal.value = null;
    navSectionSignal.value = 'spaces';
  } finally {
    finishNavigation();
  }
}

export function navigateToSpaceConfigure(
  spaceId: string,
  tab?: 'agents' | 'workflows' | 'settings',
  replace = false
): void {
  if (routerState.isNavigating) return;

  const targetPath = createSpaceConfigurePath(spaceId, tab);
  if (getCurrentPath() !== targetPath) {
    routerState.isNavigating = true;
    try {
      pushPath(targetPath, { spaceId }, replace);
    } finally {
      finishNavigation();
    }
  }

  setCurrentSpaceRouteId(spaceId);
  currentSpaceViewModeSignal.value = 'configure';
  currentSpaceConfigureTabSignal.value = tab ?? 'agents';
  currentSpaceSessionIdSignal.value = null;
  currentSpaceTaskIdSignal.value = null;
  currentSpaceTaskViewTabSignal.value = 'thread';
  currentSpaceAgentHandleSignal.value = null;
  currentSessionIdSignal.value = null;
  navSectionSignal.value = 'spaces';
}

export function navigateToSpaceGoals(spaceId: string, replace = false): void {
  if (routerState.isNavigating) return;

  const targetPath = createSpaceGoalsPath(spaceId);
  if (getCurrentPath() !== targetPath) {
    routerState.isNavigating = true;
    try {
      pushPath(targetPath, { spaceId }, replace);
    } finally {
      finishNavigation();
    }
  }

  setCurrentSpaceRouteId(spaceId);
  currentSpaceViewModeSignal.value = 'goals';
  currentSpaceSessionIdSignal.value = null;
  currentSpaceTaskIdSignal.value = null;
  currentSpaceTaskViewTabSignal.value = 'thread';
  currentSpaceAgentHandleSignal.value = null;
  currentSessionIdSignal.value = null;
  navSectionSignal.value = 'spaces';
}

export function navigateToSpaceMemories(spaceId: string, replace = false): void {
  if (routerState.isNavigating) return;

  const targetPath = createSpaceMemoriesPath(spaceId);
  if (getCurrentPath() !== targetPath) {
    routerState.isNavigating = true;
    try {
      pushPath(targetPath, { spaceId }, replace);
    } finally {
      finishNavigation();
    }
  }

  setCurrentSpaceRouteId(spaceId);
  currentSpaceViewModeSignal.value = 'memories';
  currentSpaceSessionIdSignal.value = null;
  currentSpaceTaskIdSignal.value = null;
  currentSpaceTaskViewTabSignal.value = 'thread';
  currentSpaceAgentHandleSignal.value = null;
  currentSessionIdSignal.value = null;
  navSectionSignal.value = 'spaces';
}

export function navigateToSpaceEvolve(spaceId: string, replace = false): void {
  if (routerState.isNavigating) return;

  const targetPath = createSpaceEvolvePath(spaceId);
  if (getCurrentPath() !== targetPath) {
    routerState.isNavigating = true;
    try {
      pushPath(targetPath, { spaceId }, replace);
    } finally {
      finishNavigation();
    }
  }

  setCurrentSpaceRouteId(spaceId);
  currentSpaceViewModeSignal.value = 'forge';
  currentSpaceSessionIdSignal.value = null;
  currentSpaceTaskIdSignal.value = null;
  currentSpaceTaskViewTabSignal.value = 'thread';
  currentSpaceAgentHandleSignal.value = null;
  currentSessionIdSignal.value = null;
  navSectionSignal.value = 'spaces';
}

export function navigateToSpaceForge(spaceId: string, replace = false): void {
  navigateToSpaceEvolve(spaceId, replace);
}

export function navigateToSpaceTasks(
  spaceId: string,
  tab?: 'action' | 'active' | 'completed' | 'draft' | 'scheduled',
  replace = false
): void {
  if (routerState.isNavigating) return;

  const targetPath = createSpaceTasksPath(spaceId, tab);
  if (getCurrentPath() !== targetPath) {
    routerState.isNavigating = true;
    try {
      pushPath(targetPath, { spaceId }, replace);
    } finally {
      finishNavigation();
    }
  }

  setCurrentSpaceRouteId(spaceId);
  currentSpaceViewModeSignal.value = 'tasks';
  currentSpaceTasksFilterTabSignal.value = tab ?? 'active';
  currentSpaceSessionIdSignal.value = null;
  currentSpaceTaskIdSignal.value = null;
  currentSpaceTaskViewTabSignal.value = 'thread';
  currentSpaceAgentHandleSignal.value = null;
  currentSessionIdSignal.value = null;
  navSectionSignal.value = 'spaces';
}

export function navigateToSpaceSessions(spaceId: string, replace = false): void {
  if (routerState.isNavigating) return;

  const targetPath = createSpaceSessionsPath(spaceId);
  if (getCurrentPath() !== targetPath) {
    routerState.isNavigating = true;
    try {
      pushPath(targetPath, { spaceId }, replace);
    } finally {
      finishNavigation();
    }
  }

  setCurrentSpaceRouteId(spaceId);
  currentSpaceViewModeSignal.value = 'sessions';
  currentSpaceSessionIdSignal.value = null;
  currentSpaceTaskIdSignal.value = null;
  currentSpaceTaskViewTabSignal.value = 'thread';
  currentSpaceAgentHandleSignal.value = null;
  currentSessionIdSignal.value = null;
  navSectionSignal.value = 'spaces';
}

export function navigateToSpaceSession(spaceId: string, sessionId: string, replace = false): void {
  if (routerState.isNavigating) return;

  const targetPath = createSpaceSessionPath(spaceId, sessionId);
  if (getCurrentPath() !== targetPath) {
    routerState.isNavigating = true;
    try {
      pushPath(targetPath, { spaceId, sessionId }, replace);
    } finally {
      finishNavigation();
    }
  }

  setCurrentSpaceRouteId(spaceId);
  currentSpaceViewModeSignal.value = 'overview';
  currentSpaceSessionIdSignal.value = sessionId;
  currentSpaceTaskIdSignal.value = null;
  currentSpaceTaskViewTabSignal.value = 'thread';
  currentSpaceAgentHandleSignal.value = null;
  currentSessionIdSignal.value = null;
  navSectionSignal.value = 'spaces';
}

export function navigateToSpaceTask(
  spaceId: string,
  taskId: string,
  view?: 'thread' | 'timeline' | 'log' | 'canvas' | 'artifacts',
  replace = false
): void {
  if (routerState.isNavigating) return;

  const targetPath = createSpaceTaskPath(spaceId, taskId, view);
  if (getCurrentPath() !== targetPath) {
    routerState.isNavigating = true;
    try {
      pushPath(targetPath, { spaceId, taskId }, replace);
    } finally {
      finishNavigation();
    }
  }

  setCurrentSpaceRouteId(spaceId);
  currentSpaceViewModeSignal.value = 'overview';
  currentSpaceTaskIdSignal.value = taskId;
  currentSpaceTaskViewTabSignal.value = view ?? 'thread';
  currentSpaceAgentHandleSignal.value = null;
  currentSpaceSessionIdSignal.value = null;
  currentSessionIdSignal.value = null;
  navSectionSignal.value = 'spaces';
}

export function navigateToSpaceAgent(
  spaceId: string,
  replaceOrHandle?: boolean | string,
  replace = false
): void {
  if (routerState.isNavigating) return;

  const handle = typeof replaceOrHandle === 'string' ? replaceOrHandle : undefined;
  const shouldReplace = typeof replaceOrHandle === 'boolean' ? replaceOrHandle : replace;
  const targetPath = createSpaceAgentPath(spaceId, handle);
  if (getCurrentPath() !== targetPath) {
    routerState.isNavigating = true;
    try {
      pushPath(targetPath, { spaceId, handle }, shouldReplace);
    } finally {
      finishNavigation();
    }
  }

  setCurrentSpaceRouteId(spaceId);
  currentSpaceViewModeSignal.value = 'agents';
  currentSpaceSessionIdSignal.value = null;
  currentSpaceTaskIdSignal.value = null;
  currentSpaceTaskViewTabSignal.value = 'thread';
  currentSpaceAgentHandleSignal.value = handle ?? null;
  currentSessionIdSignal.value = null;
  navSectionSignal.value = 'spaces';
}

function applyPathToSignals(path: string, search = window.location.search): string | null {
  const legacyArchivedTasksMatch = path.match(SPACE_TASKS_ARCHIVED_ROUTE_PATTERN);
  if (legacyArchivedTasksMatch) {
    pushPath(
      createSpaceTasksPath(legacyArchivedTasksMatch[1], 'completed'),
      {
        spaceId: legacyArchivedTasksMatch[1],
      },
      true
    );
  }

  const legacyForgeMatch = path.match(SPACE_FORGE_ROUTE_PATTERN);
  if (legacyForgeMatch) {
    pushPath(
      createSpaceEvolvePath(legacyForgeMatch[1]),
      {
        spaceId: legacyForgeMatch[1],
      },
      true
    );
  }

  const sessionId = getSessionIdFromPath(path);
  const spaceConfigureTab = getSpaceConfigureTabFromPath(path);
  const spaceConfigure = spaceConfigureTab
    ? spaceConfigureTab.spaceId
    : getSpaceConfigureFromPath(path);
  const spaceGoals = getSpaceGoalsFromPath(path);
  const spaceMemories = getSpaceMemoriesFromPath(path);
  const spaceEvolve = getSpaceEvolveFromPath(path);
  const spaceTasksTab = getSpaceTasksTabFromPath(path);
  const spaceTasks = spaceTasksTab ? spaceTasksTab.spaceId : getSpaceTasksFromPath(path);
  const spaceTaskView = getSpaceTaskViewFromPath(path);
  const spaceTask = spaceTaskView
    ? { spaceId: spaceTaskView.spaceId, taskId: spaceTaskView.taskId }
    : getSpaceTaskIdFromPath(path);
  const spaceSessions = getSpaceSessionsListFromPath(path);
  const spaceSession = getSpaceSessionIdFromPath(path);
  const spaceAgentDetail = getSpaceAgentDetailFromPath(path);
  const spaceAgent = getSpaceAgentFromPath(path);
  const spaceId = getSpaceIdFromPath(path);

  batch(() => {
    if (spaceTask) {
      setCurrentSpaceRouteId(spaceTask.spaceId);
      currentSpaceViewModeSignal.value = 'overview';
      currentSpaceTaskIdSignal.value = spaceTask.taskId;
      currentSpaceTaskViewTabSignal.value = spaceTaskView?.view ?? 'thread';
      currentSpaceSessionIdSignal.value = null;
      currentSessionIdSignal.value = null;
      navSectionSignal.value = 'spaces';
    } else if (spaceSession) {
      setCurrentSpaceRouteId(spaceSession.spaceId);
      currentSpaceViewModeSignal.value = 'overview';
      currentSpaceSessionIdSignal.value = spaceSession.sessionId;
      currentSpaceTaskIdSignal.value = null;
      currentSpaceTaskViewTabSignal.value = 'thread';
      currentSpaceAgentHandleSignal.value = null;
      currentSessionIdSignal.value = null;
      navSectionSignal.value = 'spaces';
    } else if (spaceAgentDetail) {
      setCurrentSpaceRouteId(spaceAgentDetail.spaceId);
      currentSpaceViewModeSignal.value = 'agents';
      currentSpaceSessionIdSignal.value = null;
      currentSpaceTaskIdSignal.value = null;
      currentSpaceTaskViewTabSignal.value = 'thread';
      currentSpaceAgentHandleSignal.value = spaceAgentDetail.handle;
      currentSessionIdSignal.value = null;
      navSectionSignal.value = 'spaces';
    } else if (spaceAgent) {
      setCurrentSpaceRouteId(spaceAgent);
      currentSpaceViewModeSignal.value = 'agents';
      currentSpaceSessionIdSignal.value = null;
      currentSpaceTaskIdSignal.value = null;
      currentSpaceTaskViewTabSignal.value = 'thread';
      currentSpaceAgentHandleSignal.value = null;
      currentSessionIdSignal.value = null;
      navSectionSignal.value = 'spaces';
    } else if (spaceGoals) {
      setCurrentSpaceRouteId(spaceGoals);
      currentSpaceViewModeSignal.value = 'goals';
      currentSpaceSessionIdSignal.value = null;
      currentSpaceTaskIdSignal.value = null;
      currentSpaceTaskViewTabSignal.value = 'thread';
      currentSpaceAgentHandleSignal.value = null;
      currentSessionIdSignal.value = null;
      navSectionSignal.value = 'spaces';
    } else if (spaceMemories) {
      setCurrentSpaceRouteId(spaceMemories);
      currentSpaceViewModeSignal.value = 'memories';
      currentSpaceSessionIdSignal.value = null;
      currentSpaceTaskIdSignal.value = null;
      currentSpaceTaskViewTabSignal.value = 'thread';
      currentSpaceAgentHandleSignal.value = null;
      currentSessionIdSignal.value = null;
      navSectionSignal.value = 'spaces';
    } else if (spaceEvolve) {
      setCurrentSpaceRouteId(spaceEvolve);
      currentSpaceViewModeSignal.value = 'forge';
      currentSpaceSessionIdSignal.value = null;
      currentSpaceTaskIdSignal.value = null;
      currentSpaceTaskViewTabSignal.value = 'thread';
      currentSpaceAgentHandleSignal.value = null;
      currentSessionIdSignal.value = null;
      navSectionSignal.value = 'spaces';
    } else if (spaceTasks) {
      setCurrentSpaceRouteId(spaceTasks);
      currentSpaceViewModeSignal.value = 'tasks';
      currentSpaceTasksFilterTabSignal.value = spaceTasksTab?.tab ?? 'active';
      currentSpaceSessionIdSignal.value = null;
      currentSpaceTaskIdSignal.value = null;
      currentSpaceTaskViewTabSignal.value = 'thread';
      currentSpaceAgentHandleSignal.value = null;
      currentSessionIdSignal.value = null;
      navSectionSignal.value = 'spaces';
    } else if (spaceSessions) {
      setCurrentSpaceRouteId(spaceSessions);
      currentSpaceViewModeSignal.value = 'sessions';
      currentSpaceSessionIdSignal.value = null;
      currentSpaceTaskIdSignal.value = null;
      currentSpaceTaskViewTabSignal.value = 'thread';
      currentSpaceAgentHandleSignal.value = null;
      currentSessionIdSignal.value = null;
      navSectionSignal.value = 'spaces';
    } else if (spaceConfigure) {
      setCurrentSpaceRouteId(spaceConfigure);
      currentSpaceViewModeSignal.value = 'configure';
      currentSpaceConfigureTabSignal.value = spaceConfigureTab?.tab ?? 'agents';
      currentSpaceSessionIdSignal.value = null;
      currentSpaceTaskIdSignal.value = null;
      currentSpaceTaskViewTabSignal.value = 'thread';
      currentSpaceAgentHandleSignal.value = null;
      currentSessionIdSignal.value = null;
      navSectionSignal.value = 'spaces';
    } else if (spaceId) {
      setCurrentSpaceRouteId(spaceId);
      currentSpaceViewModeSignal.value = 'overview';
      currentSpaceSessionIdSignal.value = null;
      currentSpaceTaskIdSignal.value = null;
      currentSpaceTaskViewTabSignal.value = 'thread';
      currentSpaceAgentHandleSignal.value = null;
      currentSessionIdSignal.value = null;
      navSectionSignal.value = 'spaces';
    } else if (SESSIONS_ROUTE_PATTERN.test(path)) {
      setSessionRoute(null);
      navSectionSignal.value = 'chats';
    } else if (SPACES_ROUTE_PATTERN.test(path) || path === '/') {
      setSpacesListRoute();
    } else if (SETTINGS_ROUTE_PATTERN.test(path)) {
      setSessionRoute(null);
      settingsSectionSignal.value = getSettingsSectionFromSearch(search);
      navSectionSignal.value = 'settings';
    } else {
      setSessionRoute(sessionId);
      navSectionSignal.value = sessionId ? 'chats' : 'spaces';
    }
  });

  return sessionId;
}

function handlePopState(_event: PopStateEvent): void {
  if (routerState.isNavigating) return;

  const overlayOpen = spaceOverlaySessionIdSignal.value || spaceOverlayPendingAgentNameSignal.value;
  if (overlayOpen && !window.history.state?.overlaySessionId) {
    spaceOverlaySessionIdSignal.value = null;
    spaceOverlayAgentNameSignal.value = null;
    spaceOverlayHighlightMessageIdSignal.value = null;
    spaceOverlayTaskContextSignal.value = null;
    spaceOverlayPendingTaskIdSignal.value = null;
    spaceOverlayPendingAgentNameSignal.value = null;
    return;
  }

  applyPathToSignals(getCurrentPath(), window.location.search);
}

export function initializeRouter(): string | null {
  if (routerState.isInitialized) {
    return getSessionIdFromPath(getCurrentPath());
  }

  const initialSessionId = applyPathToSignals(getCurrentPath(), window.location.search);
  window.addEventListener('popstate', handlePopState);
  routerState.isInitialized = true;
  return initialSessionId;
}

export function pushOverlayHistory(
  sessionId: string,
  agentName?: string,
  highlightMessageId?: string,
  taskContext?: SpaceOverlayTaskContext | null
): void {
  const currentPath = getCurrentPath();
  window.history.pushState(
    { ...window.history.state, overlaySessionId: sessionId },
    '',
    currentPath
  );
  spaceOverlaySessionIdSignal.value = sessionId;
  spaceOverlayAgentNameSignal.value = agentName ?? null;
  spaceOverlayHighlightMessageIdSignal.value = highlightMessageId ?? null;
  spaceOverlayTaskContextSignal.value = taskContext ?? null;
  spaceOverlayPendingTaskIdSignal.value = null;
  spaceOverlayPendingAgentNameSignal.value = null;
}

export function pushOverlayHistoryForPendingAgent(
  taskId: string,
  agentName: string,
  workflowNodeId?: string | null
): void {
  const currentPath = getCurrentPath();
  window.history.pushState(
    { ...window.history.state, overlaySessionId: `pending:${taskId}:${agentName}` },
    '',
    currentPath
  );
  spaceOverlayPendingTaskIdSignal.value = taskId;
  spaceOverlayPendingAgentNameSignal.value = agentName;
  spaceOverlaySessionIdSignal.value = null;
  spaceOverlayAgentNameSignal.value = agentName;
  spaceOverlayHighlightMessageIdSignal.value = null;
  spaceOverlayTaskContextSignal.value = {
    taskId,
    agentName,
    ...(workflowNodeId ? { workflowNodeId } : {}),
  };
}

export function replaceOverlayHistory(
  sessionId: string,
  agentName?: string,
  highlightMessageId?: string,
  taskContext: SpaceOverlayTaskContext | null = spaceOverlayTaskContextSignal.value
): void {
  const currentPath = getCurrentPath();
  window.history.replaceState(
    { ...window.history.state, overlaySessionId: sessionId },
    '',
    currentPath
  );
  spaceOverlaySessionIdSignal.value = sessionId;
  spaceOverlayAgentNameSignal.value = agentName ?? null;
  spaceOverlayHighlightMessageIdSignal.value = highlightMessageId ?? null;
  spaceOverlayTaskContextSignal.value = taskContext;
  spaceOverlayPendingTaskIdSignal.value = null;
  spaceOverlayPendingAgentNameSignal.value = null;
}

export function clearOverlayHighlightMessageId(): void {
  spaceOverlayHighlightMessageIdSignal.value = null;
}

export function clearOverlaySignals(): void {
  spaceOverlaySessionIdSignal.value = null;
  spaceOverlayAgentNameSignal.value = null;
  spaceOverlayHighlightMessageIdSignal.value = null;
  spaceOverlayTaskContextSignal.value = null;
  spaceOverlayPendingTaskIdSignal.value = null;
  spaceOverlayPendingAgentNameSignal.value = null;
}

export function closeOverlayHistory(): void {
  if (window.history.state?.overlaySessionId) {
    clearOverlaySignals();
    window.history.back();
  } else {
    clearOverlaySignals();
  }
}

export function cleanupRouter(): void {
  window.removeEventListener('popstate', handlePopState);
  routerState.isInitialized = false;
  routerState.isNavigating = false;
}

export function getRouterState(): Readonly<RouterState> {
  return { ...routerState };
}

export function isRouterInitialized(): boolean {
  return routerState.isInitialized;
}
