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
import { currentSessionIdSignal, navSectionSignal } from './lib/signals.ts';
import { initSessionStatusTracking } from './lib/session-status.ts';
import { globalStore } from './lib/global-store.ts';
import { sessionStore } from './lib/session-store.ts';
import {
  initializeRouter,
  navigateToSession,
  navigateToSessions,
  navigateToSettings,
} from './lib/router.ts';
import { deriveAppExpectedPath } from './lib/app-routing.ts';
import { extensionNav } from './lib/web-extensions.ts';

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
    let disposed = false;
    let disposeSelection: (() => void) | undefined;

    const init = async () => {
      try {
        const hub = await connectionManager.getHub();

        await globalStore.initialize().catch(() => {});

        await initializeApplicationState(hub, currentSessionIdSignal);

        initSessionStatusTracking();
        if (disposed) return;

        disposeSelection = effect(() => {
          const sessionId = currentSessionIdSignal.value;
          if (extensionNav().some((nav) => nav.holdsSessionSelection())) return;
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

    const disposeRouting = effect(() => {
      const sessionId = currentSessionIdSignal.value;
      const navSection = navSectionSignal.value;
      const extensionRoute = extensionNav().flatMap((nav) => nav.currentRoute() ?? [])[0];
      const expectedPath = deriveAppExpectedPath({
        sessionId,
        extensionPath: extensionRoute?.path ?? null,
        navSection,
      });

      if (window.location.pathname !== expectedPath) {
        if (sessionId) {
          navigateToSession(sessionId, true);
        } else if (extensionRoute) {
          extensionRoute.open();
        } else if (navSection === 'settings') {
          navigateToSettings(true);
        } else {
          navigateToSessions(true);
        }
      }
    });

    return () => {
      disposed = true;
      disposeSelection?.();
      disposeRouting();
    };
  }, []);

  return (
    <>
      <div class="desktop-window-shell flex h-safe-app overflow-hidden bg-app-sidebar relative pt-safe">
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
