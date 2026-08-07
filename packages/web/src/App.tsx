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
// Importing for side effect: registers the default command set on the
// commandRegistry singleton so the palette has commands before first render.
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
  navigateToSpaceForge,
  navigateToSpaceTasks,
  navigateToSpaceAgent,
  navigateToSpaceSession,
  navigateToSpaceTask,
  navigateToSettings,
} from './lib/router.ts';
import { deriveAppExpectedPath } from './lib/app-routing.ts';

export function App() {
  // Set --safe-height CSS custom property on iPad Safari for correct viewport sizing
  useViewportSafety();

  // Cmd+K command palette + any other registered shortcuts.
  useGlobalShortcuts();

  useEffect(() => {
    const isTauriRuntime = '__TAURI_INTERNALS__' in window || 'isTauri' in window;
    document.documentElement.classList.toggle('tauri-desktop', isTauriRuntime);

    return () => {
      document.documentElement.classList.remove('tauri-desktop');
    };
  }, []);

  useEffect(() => {
    // STEP 1: Initialize URL-based router BEFORE any state management
    // This ensures we read the session ID from URL on page load
    const initialSessionId = initializeRouter();

    // STEP 2: Initialize state management when app mounts
    const init = async () => {
      try {
        // Wait for MessageHub connection to be ready
        const hub = await connectionManager.getHub();

        // Initialize new unified stores (Phase 3 migration)
        await globalStore.initialize();

        // Initialize legacy state channels (will be removed in Phase 5)
        // Pass initialSessionId so state channels know the URL state
        await initializeApplicationState(hub, currentSessionIdSignal);

        // Initialize session status tracking for sidebar live indicators
        initSessionStatusTracking();

        // Sync currentSessionIdSignal with sessionStore.select()
        // This bridges the old signal-based approach with the new store
        effect(() => {
          const sessionId = currentSessionIdSignal.value;
          const spaceSessionId = currentSpaceSessionIdSignal.value;
          // Don't clobber sessions managed by space routes
          // (ChatContainer calls sessionStore.select directly in that case)
          if (spaceSessionId) return;
          sessionStore.select(sessionId);
        });

        // STEP 3: After connection is ready, restore session from URL
        // If the URL has a session ID, set it in the signal
        // This is done AFTER state is initialized to ensure proper syncing
        if (initialSessionId) {
          batch(() => {
            currentSessionIdSignal.value = initialSessionId;
          });
        }
      } catch {
        // State initialization failed - app will use default state
      }
    };

    init();

    // STEP 4: Sync URL when session/space changes from external sources
    // (e.g., session created/deleted in another tab)
    // This effect watches for signal changes and updates the URL
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

      // Only update URL if it's out of sync
      // This prevents unnecessary history updates and loops
      if (currentPath !== expectedPath) {
        if (sessionId) {
          navigateToSession(sessionId, true); // replace=true to avoid polluting history
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
          navigateToSpaceForge(spaceId, true);
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
        {/* Sidebar — section switcher, section content, settings */}
        <ContextPanel />

        {/* Main Content — rounded-left "card" on desktop; the sidebar shell
				    behind shows through the corners to separate it from the panels.
				    BottomTabBar is inline (flex-shrink-0) so no extra padding needed. */}
        <div class="flex-1 flex flex-col overflow-hidden min-w-0 bg-app-content md:rounded-l-[28px]">
          <MainContent />
        </div>

        <RightPanel />
        <RightPanelToggle />
      </div>

      {/* Global Toast Container */}
      <ToastContainer />

      {/* Command palette (Cmd+K) */}
      <CommandPalette />

      {/* Connection Overlay - blocks UI when disconnected */}
      <ConnectionOverlay />
    </>
  );
}
