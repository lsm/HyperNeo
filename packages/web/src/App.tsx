import { useEffect } from 'preact/hooks';
import { effect, batch } from '@preact/signals';
import { useViewportSafety } from './hooks/useViewportSafety.ts';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts.ts';

import { ContextPanel } from './islands/ContextPanel.tsx';
import MainContent from './islands/MainContent.tsx';
import { RightPanel, RightPanelToggle } from './islands/RightPanel.tsx';
import ToastContainer from './islands/ToastContainer.tsx';
import { CommandPalette } from './islands/CommandPalette.tsx';
import { ConnectionOverlay } from './components/ConnectionOverlay.tsx';
import { connectionManager } from './lib/connection-manager.ts';
import { initializeApplicationState } from './lib/state.ts';
import './lib/default-commands.ts';
import {
  currentSessionIdSignal,
  currentSpaceAgentHandleSignal,
  currentSpaceIdSignal,
  currentSpaceSessionIdSignal,
  currentSpaceTaskIdSignal,
  currentSpaceViewModeSignal,
  currentSpaceConfigureTabSignal,
  currentSpaceTasksFilterTabSignal,
  currentSpaceTaskViewTabSignal,
  navSectionSignal,
} from './lib/signals.ts';
import { initSessionStatusTracking } from './lib/session-status.ts';
import { globalStore } from './lib/global-store.ts';
import { sessionStore } from './lib/session-store.ts';
import {
  initializeRouter,
  navigateToSession,
  navigateToHome,
  navigateToSessions,
  navigateToSpacesPage,
  navigateToSpace,
  navigateToSpaceConfigure,
  navigateToSpaceSessions,
  navigateToSpaceGoals,
  navigateToSpaceMemories,
  navigateToSpaceEvolve,
  navigateToSpaceTasks,
  navigateToSpaceAgent,
  navigateToSpaceSession,
  navigateToSpaceTask,
  navigateToSettings,
} from './lib/router.ts';
import { deriveAppExpectedPath } from './lib/app-routing.ts';

export function App() {
  useViewportSafety();

  useGlobalShortcuts();

  useEffect(() => {
    const isTauriRuntime = '__TAURI_INTERNALS__' in window || 'isTauri' in window;
    document.documentElement.classList.toggle('tauri-desktop', isTauriRuntime);

    return () => {
      document.documentElement.classList.remove('tauri-desktop');
    };
  }, []);

  useEffect(() => {
    const initialSessionId = initializeRouter();

    const init = async () => {
      try {
        const hub = await connectionManager.getHub();

        await globalStore.initialize();

        await initializeApplicationState(hub, currentSessionIdSignal);

        initSessionStatusTracking();

        effect(() => {
          const sessionId = currentSessionIdSignal.value;
          const spaceSessionId = currentSpaceSessionIdSignal.value;
          if (spaceSessionId) return;
          sessionStore.select(sessionId);
        });

        if (initialSessionId) {
          batch(() => {
            currentSessionIdSignal.value = initialSessionId;
          });
        }
      } catch {}
    };

    init();

    return effect(() => {
      const sessionId = currentSessionIdSignal.value;
      const spaceId = currentSpaceIdSignal.value;
      const spaceSessionId = currentSpaceSessionIdSignal.value;
      const spaceTaskId = currentSpaceTaskIdSignal.value;
      const spaceAgentHandle = currentSpaceAgentHandleSignal.value;
      const spaceViewMode = currentSpaceViewModeSignal.value;
      const spaceConfigureTab = currentSpaceConfigureTabSignal.value;
      const spaceTasksFilterTab = currentSpaceTasksFilterTabSignal.value;
      const spaceTaskViewTab = currentSpaceTaskViewTabSignal.value;
      const navSection = navSectionSignal.value;
      const currentPath = window.location.pathname;
      const expectedPath = deriveAppExpectedPath({
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
      });

      if (currentPath !== expectedPath) {
        if (sessionId) {
          navigateToSession(sessionId, true);
        } else if (spaceTaskId && spaceId) {
          navigateToSpaceTask(
            spaceId,
            spaceTaskId,
            spaceTaskViewTab !== 'thread' ? spaceTaskViewTab : undefined,
            true
          );
        } else if (spaceId && spaceViewMode === 'agents') {
          navigateToSpaceAgent(spaceId, spaceAgentHandle ?? true, true);
        } else if (spaceSessionId && spaceId) {
          navigateToSpaceSession(spaceId, spaceSessionId, true);
        } else if (spaceId && spaceViewMode === 'sessions') {
          navigateToSpaceSessions(spaceId, true);
        } else if (spaceId && spaceViewMode === 'goals') {
          navigateToSpaceGoals(spaceId, true);
        } else if (spaceId && spaceViewMode === 'memories') {
          navigateToSpaceMemories(spaceId, true);
        } else if (spaceId && spaceViewMode === 'forge') {
          navigateToSpaceEvolve(spaceId, true);
        } else if (spaceId && spaceViewMode === 'tasks') {
          navigateToSpaceTasks(spaceId, undefined, true);
        } else if (spaceId && spaceViewMode === 'configure') {
          navigateToSpaceConfigure(spaceId, undefined, true);
        } else if (spaceId) {
          navigateToSpace(spaceId, true);
        } else if (navSection === 'spaces') {
          navigateToSpacesPage(true);
        } else if (navSection === 'chats') {
          navigateToSessions(true);
        } else if (navSection === 'settings') {
          navigateToSettings(true);
        } else {
          navigateToHome(true);
        }
      }
    });
  }, []);

  return (
    <>
      <div class="desktop-window-shell flex h-dvh overflow-hidden bg-app-sidebar relative pt-safe">
        <ContextPanel />

        <div class="flex-1 flex flex-col overflow-hidden min-w-0 bg-app-content md:rounded-l-[28px]">
          <MainContent />
        </div>

        <RightPanel />
        <RightPanelToggle />
      </div>

      <ToastContainer />

      <CommandPalette />

      <ConnectionOverlay />
    </>
  );
}
