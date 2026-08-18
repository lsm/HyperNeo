import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupRouter,
  createSessionPath,
  createSpaceAgentPath,
  createSpaceConfigurePath,
  createSpaceGoalsPath,
  createSpaceEvolvePath,
  createSpaceForgePath,
  createSpacePath,
  createSpaceSessionPath,
  createSpaceSessionsPath,
  createSpaceTaskPath,
  createSpaceTasksPath,
  getSessionIdFromPath,
  getSpaceAgentFromPath,
  getSpaceConfigureTabFromPath,
  getSpaceGoalsFromPath,
  getSpaceEvolveFromPath,
  getSpaceForgeFromPath,
  getSpaceIdFromPath,
  getSpaceTaskIdFromPath,
  getSpaceTaskViewFromPath,
  initializeRouter,
  navigateBack,
  navigateToHome,
  navigateToSession,
  navigateToSettings,
  navigateToSpace,
  navigateToSpaceAgent,
  navigateToSpaceConfigure,
  navigateToSpaceGoals,
  navigateToSpaceEvolve,
  navigateToSpaceForge,
  navigateToSpaceSession,
  navigateToSpacesPage,
  navigateToSpaceTask,
  navigateToSpaceTasks,
} from '../router';
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
  settingsSectionSignal,
} from '../signals';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const SPACE_ID = 'demo-space';
const TASK_ID = 't-42';
const IN_APP_HISTORY_DEPTH_KEY = '__hyperneoInAppHistoryDepth';

function resetSignals() {
  currentSessionIdSignal.value = null;
  currentSpaceIdSignal.value = null;
  currentSpaceCanonicalIdSignal.value = null;
  currentSpaceAgentHandleSignal.value = null;
  currentSpaceSessionIdSignal.value = null;
  currentSpaceTaskIdSignal.value = null;
  currentSpaceViewModeSignal.value = 'overview';
  currentSpaceConfigureTabSignal.value = 'agents';
  currentSpaceTasksFilterTabSignal.value = 'active';
  currentSpaceTaskViewTabSignal.value = 'thread';
  navSectionSignal.value = 'spaces';
  settingsSectionSignal.value = 'general';
}

function finishNavigation() {
  vi.runAllTimers();
}

function setPath(path: string) {
  const url = new URL(path, 'https://hyperneo.test');
  Object.defineProperty(window, 'location', {
    value: { pathname: url.pathname, search: url.search },
    configurable: true,
  });
}

describe('router', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cleanupRouter();
    resetSignals();
    setPath('/');
    window.history.replaceState(null, '', '/');
    vi.spyOn(window.history, 'pushState');
    vi.spyOn(window.history, 'replaceState');
  });

  afterEach(() => {
    cleanupRouter();
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetSignals();
  });

  it('creates and extracts session and space paths', () => {
    expect(createSessionPath(SESSION_ID)).toBe(`/session/${SESSION_ID}`);
    expect(getSessionIdFromPath(`/session/${SESSION_ID}`)).toBe(SESSION_ID);
    expect(createSpacePath(SPACE_ID)).toBe(`/space/${SPACE_ID}`);
    expect(createSpaceConfigurePath(SPACE_ID, 'settings')).toBe(
      `/space/${SPACE_ID}/configure/settings`
    );
    expect(createSpaceGoalsPath(SPACE_ID)).toBe(`/space/${SPACE_ID}/goals`);
    expect(getSpaceGoalsFromPath(`/space/${SPACE_ID}/goals`)).toBe(SPACE_ID);
    expect(createSpaceEvolvePath(SPACE_ID)).toBe(`/space/${SPACE_ID}/evolve`);
    expect(getSpaceEvolveFromPath(`/space/${SPACE_ID}/evolve`)).toBe(SPACE_ID);
    expect(getSpaceIdFromPath(`/space/${SPACE_ID}/evolve`)).toBe(SPACE_ID);
    expect(createSpaceForgePath(SPACE_ID)).toBe(`/space/${SPACE_ID}/evolve`);
    expect(getSpaceForgeFromPath(`/space/${SPACE_ID}/forge`)).toBe(SPACE_ID);
    expect(getSpaceForgeFromPath(`/space/${SPACE_ID}/evolve`)).toBe(SPACE_ID);
    expect(getSpaceIdFromPath(`/space/${SPACE_ID}/forge`)).toBe(SPACE_ID);
    expect(createSpaceTasksPath(SPACE_ID, 'action')).toBe(`/space/${SPACE_ID}/tasks/action`);
    expect(createSpaceSessionsPath(SPACE_ID)).toBe(`/space/${SPACE_ID}/sessions`);
    expect(createSpaceAgentPath(SPACE_ID)).toBe(`/space/${SPACE_ID}/agents`);
    expect(createSpaceAgentPath(SPACE_ID, 'reviewer')).toBe(`/space/${SPACE_ID}/agent/reviewer`);
    expect(createSpaceSessionPath(SPACE_ID, SESSION_ID)).toBe(
      `/space/${SPACE_ID}/session/${SESSION_ID}`
    );
    expect(createSpaceTaskPath(SPACE_ID, TASK_ID, 'artifacts')).toBe(
      `/space/${SPACE_ID}/task/${TASK_ID}/artifacts`
    );
  });

  it('does not treat legacy room URLs as space routes', () => {
    const legacyPath = '/ro' + 'om/abc-123';
    expect(getSpaceIdFromPath(legacyPath)).toBeNull();
    expect(getSpaceAgentFromPath(`${legacyPath}/agent`)).toBeNull();
    expect(getSpaceTaskIdFromPath(`${legacyPath}/task/t-42`)).toBeNull();
  });

  it('initializes / as the Spaces section', () => {
    setPath('/');

    expect(initializeRouter()).toBeNull();

    expect(navSectionSignal.value).toBe('spaces');
    expect(currentSessionIdSignal.value).toBeNull();
    expect(currentSpaceIdSignal.value).toBeNull();
  });

  it('initializes space task view routes', () => {
    setPath(`/space/${SPACE_ID}/task/${TASK_ID}/canvas`);

    initializeRouter();

    expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
    expect(currentSpaceTaskIdSignal.value).toBe(TASK_ID);
    expect(currentSpaceTaskViewTabSignal.value).toBe('canvas');
    expect(navSectionSignal.value).toBe('spaces');
    expect(getSpaceTaskViewFromPath(`/space/${SPACE_ID}/task/${TASK_ID}/canvas`)).toEqual({
      spaceId: SPACE_ID,
      taskId: TASK_ID,
      view: 'canvas',
    });
    expect(getSpaceTaskViewFromPath(`/space/${SPACE_ID}/task/${TASK_ID}/timeline`)).toEqual({
      spaceId: SPACE_ID,
      taskId: TASK_ID,
      view: 'timeline',
    });
    expect(getSpaceTaskViewFromPath(`/space/${SPACE_ID}/task/${TASK_ID}/log`)).toEqual({
      spaceId: SPACE_ID,
      taskId: TASK_ID,
      view: 'log',
    });
  });

  it('initializes space configure and task list tabs', () => {
    setPath(`/space/${SPACE_ID}/configure/workflows`);
    initializeRouter();

    expect(getSpaceConfigureTabFromPath(`/space/${SPACE_ID}/configure/workflows`)).toEqual({
      spaceId: SPACE_ID,
      tab: 'workflows',
    });
    expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
    expect(currentSpaceViewModeSignal.value).toBe('configure');
    expect(currentSpaceConfigureTabSignal.value).toBe('workflows');

    cleanupRouter();
    setPath(`/space/${SPACE_ID}/tasks/completed`);
    initializeRouter();

    expect(currentSpaceViewModeSignal.value).toBe('tasks');
    expect(currentSpaceTasksFilterTabSignal.value).toBe('completed');

    cleanupRouter();
    setPath(`/space/${SPACE_ID}/goals`);
    initializeRouter();

    expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
    expect(currentSpaceViewModeSignal.value).toBe('goals');
    expect(currentSpaceSessionIdSignal.value).toBeNull();
    expect(currentSpaceTaskIdSignal.value).toBeNull();

    cleanupRouter();
    setPath(`/space/${SPACE_ID}/evolve`);
    initializeRouter();

    expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
    expect(currentSpaceViewModeSignal.value).toBe('forge');
    expect(currentSpaceSessionIdSignal.value).toBeNull();
    expect(currentSpaceTaskIdSignal.value).toBeNull();
  });

  it('redirects the legacy /forge route to the canonical /evolve route', () => {
    setPath(`/space/${SPACE_ID}/forge`);
    initializeRouter();

    expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
    expect(currentSpaceViewModeSignal.value).toBe('forge');
    expect(currentSpaceSessionIdSignal.value).toBeNull();
    expect(currentSpaceTaskIdSignal.value).toBeNull();
    expect(window.history.replaceState).toHaveBeenLastCalledWith(
      {
        spaceId: SPACE_ID,
        path: `/space/${SPACE_ID}/evolve`,
        [IN_APP_HISTORY_DEPTH_KEY]: 0,
      },
      '',
      `/space/${SPACE_ID}/evolve`
    );
  });

  it('navigates to the canonical /evolve route via the legacy Forge helper', () => {
    navigateToSpaceForge(SPACE_ID);
    finishNavigation();

    expect(currentSpaceViewModeSignal.value).toBe('forge');
    expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
    expect(window.history.pushState).toHaveBeenLastCalledWith(
      { spaceId: SPACE_ID, path: `/space/${SPACE_ID}/evolve`, [IN_APP_HISTORY_DEPTH_KEY]: 1 },
      '',
      `/space/${SPACE_ID}/evolve`
    );
  });

  it('redirects legacy archived task tabs to completed', () => {
    setPath(`/space/${SPACE_ID}/tasks/archived`);
    initializeRouter();

    expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
    expect(currentSpaceViewModeSignal.value).toBe('tasks');
    expect(currentSpaceTasksFilterTabSignal.value).toBe('completed');
    expect(window.history.replaceState).toHaveBeenLastCalledWith(
      {
        spaceId: SPACE_ID,
        path: `/space/${SPACE_ID}/tasks/completed`,
        [IN_APP_HISTORY_DEPTH_KEY]: 0,
      },
      '',
      `/space/${SPACE_ID}/tasks/completed`
    );
  });

  it('initializes settings routes from tab query parameters', () => {
    setPath('/settings?tab=providers');
    initializeRouter();

    expect(navSectionSignal.value).toBe('settings');
    expect(settingsSectionSignal.value).toBe('providers');
    expect(currentSessionIdSignal.value).toBeNull();

    cleanupRouter();
    settingsSectionSignal.value = 'providers';
    setPath('/settings?tab=unknown');
    initializeRouter();

    expect(navSectionSignal.value).toBe('settings');
    expect(settingsSectionSignal.value).toBe('general');
  });

  it('navigates to settings tabs and updates URL query parameters', () => {
    navigateToSettings('skills');

    expect(navSectionSignal.value).toBe('settings');
    expect(settingsSectionSignal.value).toBe('skills');
    expect(window.history.pushState).toHaveBeenLastCalledWith(
      { section: 'skills', path: '/settings?tab=skills', [IN_APP_HISTORY_DEPTH_KEY]: 1 },
      '',
      '/settings?tab=skills'
    );
    finishNavigation();

    navigateToSettings('providers');

    expect(settingsSectionSignal.value).toBe('providers');
    expect(window.history.pushState).toHaveBeenLastCalledWith(
      { section: 'providers', path: '/settings?tab=providers', [IN_APP_HISTORY_DEPTH_KEY]: 2 },
      '',
      '/settings?tab=providers'
    );
  });

  it('navigates session, settings, and home routes', () => {
    navigateToSession(SESSION_ID);
    expect(window.history.pushState).toHaveBeenLastCalledWith(
      { sessionId: SESSION_ID, path: `/session/${SESSION_ID}`, [IN_APP_HISTORY_DEPTH_KEY]: 1 },
      '',
      `/session/${SESSION_ID}`
    );
    expect(currentSessionIdSignal.value).toBe(SESSION_ID);
    expect(navSectionSignal.value).toBe('chats');
    finishNavigation();

    navigateToSettings();
    expect(navSectionSignal.value).toBe('settings');
    expect(currentSessionIdSignal.value).toBeNull();
    finishNavigation();

    navigateToHome();
    expect(navSectionSignal.value).toBe('spaces');
    expect(window.history.pushState).toHaveBeenLastCalledWith(
      { path: '/spaces', [IN_APP_HISTORY_DEPTH_KEY]: 3 },
      '',
      '/spaces'
    );
  });

  it('preserves the canonical space id during same-route-space navigation', () => {
    navigateToSpace('demo-slug');
    currentSpaceCanonicalIdSignal.value = 'space-uuid';
    finishNavigation();

    navigateToSpaceTasks('demo-slug', 'action');

    expect(currentSpaceIdSignal.value).toBe('demo-slug');
    expect(currentSpaceCanonicalIdSignal.value).toBe('space-uuid');
  });

  it('clears the canonical space id when the route space changes', () => {
    navigateToSpace('demo-slug');
    currentSpaceCanonicalIdSignal.value = 'space-uuid';
    finishNavigation();

    navigateToSpaceTasks('other-space', 'action');

    expect(currentSpaceIdSignal.value).toBe('other-space');
    expect(currentSpaceCanonicalIdSignal.value).toBeNull();
  });

  it('navigates space routes and clears regular session selection', () => {
    currentSessionIdSignal.value = SESSION_ID;

    navigateToSpace(SPACE_ID);
    expect(currentSessionIdSignal.value).toBeNull();
    expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
    expect(currentSpaceViewModeSignal.value).toBe('overview');
    expect(navSectionSignal.value).toBe('spaces');
    finishNavigation();

    navigateToSpaceTasks(SPACE_ID, 'action');
    expect(currentSpaceViewModeSignal.value).toBe('tasks');
    expect(currentSpaceTasksFilterTabSignal.value).toBe('action');
    finishNavigation();

    navigateToSpaceGoals(SPACE_ID);
    expect(currentSpaceViewModeSignal.value).toBe('goals');
    expect(currentSpaceSessionIdSignal.value).toBeNull();
    expect(currentSpaceTaskIdSignal.value).toBeNull();
    finishNavigation();

    navigateToSpaceEvolve(SPACE_ID);
    expect(currentSpaceViewModeSignal.value).toBe('forge');
    expect(currentSpaceSessionIdSignal.value).toBeNull();
    expect(currentSpaceTaskIdSignal.value).toBeNull();
    expect(window.history.pushState).toHaveBeenLastCalledWith(
      { spaceId: SPACE_ID, path: `/space/${SPACE_ID}/evolve`, [IN_APP_HISTORY_DEPTH_KEY]: 4 },
      '',
      `/space/${SPACE_ID}/evolve`
    );
    finishNavigation();

    navigateToSpaceConfigure(SPACE_ID, 'settings');
    expect(currentSpaceViewModeSignal.value).toBe('configure');
    expect(currentSpaceConfigureTabSignal.value).toBe('settings');
    finishNavigation();

    navigateToSpaceTask(SPACE_ID, TASK_ID, 'artifacts');
    expect(currentSpaceTaskIdSignal.value).toBe(TASK_ID);
    expect(currentSpaceTaskViewTabSignal.value).toBe('artifacts');
    finishNavigation();

    navigateToSpaceSession(SPACE_ID, SESSION_ID);
    expect(currentSpaceSessionIdSignal.value).toBe(SESSION_ID);
    expect(currentSpaceTaskIdSignal.value).toBeNull();
    finishNavigation();

    navigateToSpaceAgent(SPACE_ID);
    expect(currentSpaceSessionIdSignal.value).toBeNull();
    expect(currentSpaceViewModeSignal.value).toBe('agents');
    expect(currentSpaceAgentHandleSignal.value).toBeNull();
    finishNavigation();

    navigateToSpaceAgent(SPACE_ID, 'reviewer');
    expect(currentSpaceViewModeSignal.value).toBe('agents');
    expect(currentSpaceAgentHandleSignal.value).toBe('reviewer');
    expect(window.history.pushState).toHaveBeenLastCalledWith(
      {
        spaceId: SPACE_ID,
        handle: 'reviewer',
        path: `/space/${SPACE_ID}/agent/reviewer`,
        [IN_APP_HISTORY_DEPTH_KEY]: 9,
      },
      '',
      `/space/${SPACE_ID}/agent/reviewer`
    );
    finishNavigation();

    navigateToSpacesPage();
    expect(currentSpaceIdSignal.value).toBeNull();
    expect(navSectionSignal.value).toBe('spaces');
  });

  describe('navigateBack', () => {
    it('uses the fallback after popping back to the original deep-linked entry', () => {
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
      const fallback = vi.fn();

      navigateToSpaceTasks(SPACE_ID);
      finishNavigation();
      window.history.replaceState(
        { path: `/space/${SPACE_ID}/task/${TASK_ID}` },
        '',
        `/space/${SPACE_ID}/task/${TASK_ID}`
      );

      navigateBack(fallback);

      expect(fallback).toHaveBeenCalledTimes(1);
      expect(back).not.toHaveBeenCalled();
    });

    it('runs the fallback when no in-app history has been pushed (deep link)', () => {
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
      const fallback = vi.fn();

      navigateBack(fallback);

      expect(fallback).toHaveBeenCalledTimes(1);
      expect(back).not.toHaveBeenCalled();
    });

    it('defers to history.back once an in-app navigation has pushed an entry', () => {
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
      const fallback = vi.fn();

      navigateToSpaceTasks(SPACE_ID);
      finishNavigation();

      navigateBack(fallback);

      expect(back).toHaveBeenCalledTimes(1);
      expect(fallback).not.toHaveBeenCalled();
    });

    it('treats replace-only navigations as not going back (no pushed entry)', () => {
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
      const fallback = vi.fn();

      navigateToSpace(SPACE_ID, true);
      finishNavigation();

      navigateBack(fallback);

      expect(fallback).toHaveBeenCalledTimes(1);
      expect(back).not.toHaveBeenCalled();
    });
  });
});
