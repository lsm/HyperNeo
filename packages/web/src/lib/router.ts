import { batch } from '@preact/signals';
import {
  currentSessionIdSignal,
  navSectionSignal,
  type SettingsSection,
  settingsSectionSignal,
} from './signals.ts';

const SESSION_ROUTE_PATTERN = /^\/session\/((?:neo:)?[a-f0-9-]+)$/i;
const SESSIONS_ROUTE_PATTERN = /^\/sessions$/;
const SETTINGS_ROUTE_PATTERN = /^\/settings$/;
const SETTINGS_SECTIONS = new Set<SettingsSection>([
  'preferences',
  'general',
  'providers',
  'connections',
  'voice',
  'exa',
  'app-mcp-servers',
  'devices',
  'remote-daemons',
  'skills',
  'coding-pack',
  'neo-model',
  'models',
  'usage',
  'shortcuts',
  'about',
]);

export interface RouteExtension {
  section: string;
  applyPath(path: string): boolean;
  clearRouteState(): void;
  handlePopState(): boolean;
}

const routeExtensions: RouteExtension[] = [];

export function registerRouteExtension(extension: RouteExtension): void {
  if (!routeExtensions.includes(extension)) routeExtensions.push(extension);
}

interface RouterState {
  isInitialized: boolean;
  isNavigating: boolean;
}

export const routerState: RouterState = {
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

export function getCurrentPath(): string {
  return window.location.pathname;
}

function getCurrentPathWithSearch(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function getSettingsSectionFromSearch(search: string): SettingsSection {
  const section = new URLSearchParams(search).get('tab');
  if (section === 'custom-endpoints') return 'providers';
  if (section === 'appearance') return 'preferences';
  return section && SETTINGS_SECTIONS.has(section as SettingsSection)
    ? (section as SettingsSection)
    : 'preferences';
}

export function createSessionPath(sessionId: string): string {
  return `/session/${sessionId}`;
}

export function createSettingsPath(section?: SettingsSection): string {
  return section ? `/settings?tab=${section}` : '/settings';
}

export function pushPath(path: string, state: Record<string, unknown>, replace: boolean): void {
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

export function finishNavigation(): void {
  setTimeout(() => {
    routerState.isNavigating = false;
  }, 0);
}

function setSessionRoute(sessionId: string | null): void {
  currentSessionIdSignal.value = sessionId;
  for (const extension of routeExtensions) extension.clearRouteState();
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
    settingsSectionSignal.value = section ?? 'preferences';
    navSectionSignal.value = 'settings';
    return;
  }

  routerState.isNavigating = true;
  try {
    pushPath(targetPath, { section: section ?? 'preferences' }, shouldReplace);
    setSessionRoute(null);
    settingsSectionSignal.value = section ?? 'preferences';
    navSectionSignal.value = 'settings';
  } finally {
    finishNavigation();
  }
}

function applyPathToSignals(path: string, search = window.location.search): string | null {
  const sessionId = getSessionIdFromPath(path);

  batch(() => {
    if (routeExtensions.some((extension) => extension.applyPath(path))) return;
    if (SESSIONS_ROUTE_PATTERN.test(path)) {
      setSessionRoute(null);
      navSectionSignal.value = 'chats';
    } else if (SETTINGS_ROUTE_PATTERN.test(path)) {
      setSessionRoute(null);
      settingsSectionSignal.value = getSettingsSectionFromSearch(search);
      navSectionSignal.value = 'settings';
    } else {
      setSessionRoute(sessionId);
      navSectionSignal.value = sessionId ? 'chats' : (routeExtensions[0]?.section ?? 'chats');
    }
  });

  return sessionId;
}

function handlePopState(_event: PopStateEvent): void {
  if (routerState.isNavigating) return;

  if (routeExtensions.some((extension) => extension.handlePopState())) return;

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

export function cleanupRouter(): void {
  window.removeEventListener('popstate', handlePopState);
  routerState.isInitialized = false;
  routerState.isNavigating = false;
}
