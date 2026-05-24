import { lazy, Suspense } from 'preact/compat';
import {
  currentSessionIdSignal,
  currentSpaceIdSignal,
  currentSpaceSessionIdSignal,
  currentSpaceTaskIdSignal,
  currentSpaceViewModeSignal,
  navSectionSignal,
  settingsSectionSignal,
} from '../lib/signals.ts';
import { sessions } from '../lib/state.ts';
import { BottomTabBar } from './BottomTabBar.tsx';
import { MobileMenuButton } from '../components/ui/MobileMenuButton.tsx';

// Lazy-loaded route components — reduces initial module count in dev mode
const ChatContainer = lazy(() => import('./ChatContainer.tsx'));
const SpaceIsland = lazy(() => import('./SpaceIsland.tsx'));
const SessionsPage = lazy(() =>
  import('./SessionsPage.tsx').then((m) => ({ default: m.SessionsPage }))
);

// Lazy-loaded settings panels
const GeneralSettings = lazy(() =>
  import('../components/settings/GeneralSettings.tsx').then((m) => ({ default: m.GeneralSettings }))
);
const ProvidersSettings = lazy(() =>
  import('../components/settings/ProvidersSettings.tsx').then((m) => ({
    default: m.ProvidersSettings,
  }))
);
const CustomEndpointsSettings = lazy(() =>
  import('../components/settings/CustomEndpointsSettings.tsx').then((m) => ({
    default: m.CustomEndpointsSettings,
  }))
);
const AppMcpServersSettings = lazy(() =>
  import('../components/settings/AppMcpServersSettings.tsx').then((m) => ({
    default: m.AppMcpServersSettings,
  }))
);
const SkillsRegistry = lazy(() =>
  import('../components/settings/SkillsRegistry.tsx').then((m) => ({ default: m.SkillsRegistry }))
);
const ModelsSettings = lazy(() =>
  import('../components/settings/ModelsSettings.tsx').then((m) => ({
    default: m.ModelsSettings,
  }))
);
const UsageAnalytics = lazy(() =>
  import('../components/settings/UsageAnalytics.tsx').then((m) => ({ default: m.UsageAnalytics }))
);
const AboutSection = lazy(() =>
  import('../components/settings/AboutSection.tsx').then((m) => ({ default: m.AboutSection }))
);
const ShortcutsSettings = lazy(() =>
  import('../components/settings/ShortcutsSettings.tsx').then((m) => ({
    default: m.ShortcutsSettings,
  }))
);

/** Shared Suspense fallback for lazy-loaded route components. */
const lazyFallback = (
  <div class="flex-1 flex items-center justify-center bg-app-content">
    <div class="text-xs text-gray-600">Loading...</div>
  </div>
);

function SpacesWelcome() {
  return (
    <div class="relative flex-1 flex flex-col bg-app-content overflow-hidden">
      <div class="desktop-empty-drag-strip" data-tauri-drag-region />

      <div class="md:hidden flex items-center px-3 py-2">
        <MobileMenuButton />
      </div>
      <div class="flex-1 flex items-center justify-center px-6 pb-16">
        <div class="max-w-sm text-center">
          <svg
            class="w-12 h-12 mx-auto mb-4 text-gray-700"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={1.5}
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
            />
          </svg>
          <h1 class="text-base font-semibold text-gray-100">Autonomous agent workspaces</h1>
          <p class="mt-2 text-sm text-gray-500 leading-relaxed">
            Spaces coordinate teams of agents around a project goal. Create one to assign missions,
            track handoffs, review gates, and jump into the sessions doing the work.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function MainContent() {
  // IMPORTANT: Access .value directly in component body to enable Preact Signals auto-tracking
  // The @preact/preset-vite plugin will transform this to create proper subscriptions
  const sessionId = currentSessionIdSignal.value;
  const spaceId = currentSpaceIdSignal.value;
  const spaceSessionViewId = currentSpaceSessionIdSignal.value;
  const spaceTaskViewId = currentSpaceTaskIdSignal.value;
  const spaceViewMode = currentSpaceViewModeSignal.value;
  const sessionsList = sessions.value;
  const navSection = navSectionSignal.value;
  const settingsSection = settingsSectionSignal.value;

  // Validate that the current session actually exists in the sessions list
  // (handles case where session is deleted in another tab)
  const sessionExists = !!(sessionId && sessionsList.some((s) => s.id === sessionId));

  // Compute a stable key that changes when the major content view changes.
  // This drives the animate-fadeIn-200 transition wrapper below.
  let contentKey: string;
  if (spaceId) {
    contentKey = `space-${spaceId}-${spaceViewMode}`;
  } else if (navSection === 'spaces') {
    contentKey = 'spaces';
  } else if (sessionExists) {
    contentKey = `chat-${sessionId}`;
  } else if (navSection === 'chats') {
    contentKey = 'chats';
  } else if (navSection === 'settings') {
    // Settings sub-section changes don't re-animate — only the major section switch does
    contentKey = 'settings';
  } else {
    contentKey = 'home';
  }

  function renderContent() {
    // Space route takes priority
    if (spaceId) {
      return (
        <Suspense fallback={lazyFallback}>
          <SpaceIsland
            spaceId={spaceId}
            viewMode={spaceViewMode}
            sessionViewId={spaceSessionViewId}
            taskViewId={spaceTaskViewId}
          />
        </Suspense>
      );
    }

    // /spaces route: sidebar owns the list; main pane stays quiet.
    if (navSection === 'spaces') {
      return <SpacesWelcome />;
    }

    // If there's a valid session, show the chat
    if (sessionExists && sessionId) {
      return (
        <Suspense fallback={lazyFallback}>
          <ChatContainer key={sessionId} sessionId={sessionId} />
        </Suspense>
      );
    }

    // /sessions route: show sessions grid
    if (navSection === 'chats') {
      return (
        <Suspense fallback={lazyFallback}>
          <SessionsPage />
        </Suspense>
      );
    }

    // If Settings is selected, show the selected settings section content
    if (navSection === 'settings') {
      return (
        <div class="flex-1 flex flex-col bg-app-content overflow-hidden">
          {/* Settings Header */}
          <div
            class="relative z-10 flex h-[52px] flex-shrink-0 items-center bg-app-content px-4"
            data-tauri-drag-region
          >
            <div class="flex min-w-0 flex-1 items-center gap-3" data-tauri-drag-region>
              <MobileMenuButton />
              <h2
                class="min-w-0 truncate text-sm font-semibold text-gray-100"
                data-tauri-drag-region
              >
                Global Settings
              </h2>
            </div>
          </div>
          {/* Settings Content */}
          <div class="scrollbar-dark min-h-0 flex-1 overflow-y-auto px-4 py-4 pr-3 sm:px-6 sm:py-5 sm:pr-4">
            <div class="mx-auto w-full max-w-5xl">
              <Suspense fallback={lazyFallback}>
                {settingsSection === 'general' && <GeneralSettings />}
                {settingsSection === 'providers' && <ProvidersSettings />}
                {settingsSection === 'custom-endpoints' && <CustomEndpointsSettings />}
                {settingsSection === 'app-mcp-servers' && <AppMcpServersSettings />}
                {settingsSection === 'skills' && <SkillsRegistry />}
                {settingsSection === 'models' && <ModelsSettings />}
                {settingsSection === 'usage' && <UsageAnalytics />}
                {settingsSection === 'shortcuts' && <ShortcutsSettings />}
                {settingsSection === 'about' && <AboutSection />}
              </Suspense>
            </div>
          </div>
        </div>
      );
    }

    // Default: Space-first landing surface
    return <SpacesWelcome />;
  }

  // Wrap content in a keyed div so Preact remounts it (and replays animate-fadeIn-200)
  // whenever the major content view changes.
  // BottomTabBar sits outside the keyed div so it never remounts on view transitions.
  return (
    <>
      <div key={contentKey} class="flex-1 flex flex-col overflow-hidden animate-fadeIn-200">
        {renderContent()}
      </div>
      <BottomTabBar inline />
    </>
  );
}
