import { lazy, Suspense } from 'preact/compat';
import { useState, useEffect } from 'preact/hooks';
import {
  currentSessionIdSignal,
  currentSpaceCanonicalIdSignal,
  currentSpaceIdSignal,
  currentSpaceSessionIdSignal,
  currentSpaceTaskIdSignal,
  currentSpaceViewModeSignal,
  navSectionSignal,
  settingsSectionSignal,
} from '../lib/signals.ts';
import { navigateToSpace, navigateToSpaceTask, navigateToSpaceSession } from '../lib/router.ts';
import { spaceStore } from '../lib/space-store.ts';
import { isActionRequired, isActiveTask } from '../lib/task-filters.ts';
import { SpaceCreateDialog } from '../components/space/SpaceCreateDialog.tsx';
import { BottomTabBar } from './BottomTabBar.tsx';
import { VoiceRecordingIndicator } from '../components/voice/VoiceRecordingIndicator.tsx';
import { VoiceSurfaceContext } from '../hooks/useVoiceRecorder';
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
const VoiceSettings = lazy(() =>
  import('../components/settings/VoiceSettings.tsx').then((m) => ({ default: m.VoiceSettings }))
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

const TASK_STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  review: 'Review',
  blocked: 'Blocked',
  in_progress: 'In Progress',
  approved: 'Approved',
};

function SpacesHome() {
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const spaces = spaceStore.spacesWithTasks.value.filter((s) => s.status !== 'archived');

  useEffect(() => {
    spaceStore.initGlobalList().catch(() => {});
  }, []);

  const actionItems = spaces.flatMap((space) =>
    space.tasks.filter(isActionRequired).map((task) => ({ task, space }))
  );

  const runningItems = spaces.flatMap((space) =>
    space.tasks.filter(isActiveTask).map((task) => ({ task, space }))
  );

  const activeSessions = spaces
    .flatMap((space) =>
      space.sessions.filter((s) => s.status === 'active').map((session) => ({ session, space }))
    )
    .sort((a, b) => b.session.lastActiveAt - a.session.lastActiveAt);

  const hasContent = actionItems.length > 0 || runningItems.length > 0 || activeSessions.length > 0;

  return (
    <div class="relative flex-1 flex flex-col bg-app-content overflow-hidden">
      <div class="desktop-empty-drag-strip" data-tauri-drag-region />
      <div class="flex-1 overflow-y-auto scrollbar-dark">
        <div class="px-4 sm:px-6 py-4 sm:py-6 max-w-3xl mx-auto">
          <div class="flex items-center gap-3 mb-6">
            <div class="md:hidden">
              <MobileMenuButton />
            </div>
            <h1 class="text-sm font-semibold text-gray-100 flex-1">Spaces</h1>
            <button
              type="button"
              onClick={() => setCreateSpaceOpen(true)}
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-medium text-white transition-colors flex-shrink-0"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              New Space
            </button>
          </div>

          {spaces.length === 0 ? (
            <div class="flex flex-col items-center py-20 text-center">
              <svg
                class="w-10 h-10 text-gray-700 mb-4"
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
              <p class="text-sm font-medium text-gray-300">No spaces yet</p>
              <p class="mt-1.5 text-xs text-gray-500 max-w-xs leading-relaxed">
                Create a Space to coordinate agents around a project goal.
              </p>
              <button
                type="button"
                onClick={() => setCreateSpaceOpen(true)}
                class="mt-6 flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-medium text-white transition-colors"
              >
                Create your first Space
              </button>
            </div>
          ) : !hasContent ? (
            <div class="flex flex-col gap-6">
              <div class="flex items-center gap-2.5 py-3 text-sm text-gray-500">
                <svg
                  class="w-4 h-4 text-green-500 flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                All quiet — no active work across your spaces
              </div>
              <div class="flex flex-col gap-1">
                {spaces.map((space) => (
                  <button
                    key={space.id}
                    type="button"
                    onClick={() => navigateToSpace(space.slug)}
                    class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-white/5 transition-colors group"
                  >
                    <svg
                      class="w-4 h-4 text-gray-600 flex-shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={1.75}
                        d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                      />
                    </svg>
                    <span class="text-sm text-gray-400 group-hover:text-gray-100 transition-colors truncate flex-1">
                      {space.name}
                    </span>
                    <svg
                      class="w-3.5 h-3.5 text-gray-700 group-hover:text-gray-500 flex-shrink-0 transition-colors"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div class="flex flex-col gap-6">
              {actionItems.length > 0 && (
                <div>
                  <div class="flex items-center gap-2 mb-2 px-1">
                    <span class="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />
                    <span class="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                      Needs Attention
                    </span>
                    <span class="ml-auto text-xs font-medium tabular-nums text-amber-400">
                      {actionItems.length}
                    </span>
                  </div>
                  <div class="flex flex-col gap-0.5">
                    {actionItems.map(({ task, space }) => (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => navigateToSpaceTask(space.slug, task.id)}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-white/5 transition-colors group"
                      >
                        <div
                          class={`w-2 h-2 rounded-full flex-shrink-0 ${task.status === 'review' ? 'bg-purple-500' : 'bg-amber-500'}`}
                        />
                        <div class="min-w-0 flex-1">
                          <div class="text-sm text-gray-200 truncate">{task.title}</div>
                          <div class="text-xs text-gray-600 truncate mt-0.5">{space.name}</div>
                        </div>
                        <span
                          class={`flex-shrink-0 text-[11px] font-medium px-1.5 py-0.5 rounded ${task.status === 'review' ? 'bg-purple-500/20 text-purple-300' : 'bg-amber-500/20 text-amber-300'}`}
                        >
                          {TASK_STATUS_LABEL[task.status] ?? task.status}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {activeSessions.length > 0 && (
                <div>
                  <div class="flex items-center gap-2 mb-2 px-1">
                    <span class="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                    <span class="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                      Active Sessions
                    </span>
                    <span class="ml-auto text-xs font-medium tabular-nums text-green-400">
                      {activeSessions.length}
                    </span>
                  </div>
                  <div class="flex flex-col gap-0.5">
                    {activeSessions.map(({ session, space }) => (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => navigateToSpaceSession(space.slug, session.id)}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-white/5 transition-colors group"
                      >
                        <div class="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                        <div class="min-w-0 flex-1">
                          <div class="text-sm text-gray-200 truncate">{session.title}</div>
                          <div class="text-xs text-gray-600 truncate mt-0.5">{space.name}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {runningItems.length > 0 && (
                <div>
                  <div class="flex items-center gap-2 mb-2 px-1">
                    <span class="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
                    <span class="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                      In Progress
                    </span>
                    <span class="ml-auto text-xs font-medium tabular-nums text-blue-400">
                      {runningItems.length}
                    </span>
                  </div>
                  <div class="flex flex-col gap-0.5">
                    {runningItems.map(({ task, space }) => (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => navigateToSpaceTask(space.slug, task.id)}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-white/5 transition-colors group"
                      >
                        <div class="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                        <div class="min-w-0 flex-1">
                          <div class="text-sm text-gray-200 truncate">{task.title}</div>
                          <div class="text-xs text-gray-600 truncate mt-0.5">{space.name}</div>
                        </div>
                        <span class="flex-shrink-0 text-[11px] font-medium px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">
                          {TASK_STATUS_LABEL[task.status] ?? task.status}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <SpaceCreateDialog isOpen={createSpaceOpen} onClose={() => setCreateSpaceOpen(false)} />
    </div>
  );
}

export default function MainContent() {
  // IMPORTANT: Access .value directly in component body to enable Preact Signals auto-tracking
  // The @preact/preset-vite plugin will transform this to create proper subscriptions
  const sessionId = currentSessionIdSignal.value;
  const spaceRouteId = currentSpaceIdSignal.value;
  const spaceId = currentSpaceCanonicalIdSignal.value ?? spaceRouteId;
  const spaceSessionViewId = currentSpaceSessionIdSignal.value;
  const spaceTaskViewId = currentSpaceTaskIdSignal.value;
  const spaceViewMode = currentSpaceViewModeSignal.value;
  const navSection = navSectionSignal.value;
  const settingsSection = settingsSectionSignal.value;

  // A session route mounts ChatContainer even when the id is NOT in the cached
  // sessions list — a deep link to a stale/deleted id, or the list simply
  // hasn't loaded yet. ChatContainer + the store resolve the correct state,
  // including the unavailable-session view for a confirmed-missing id, so a
  // deep link to an invalid nonempty id never silently falls through to the
  // sessions list (task #873).

  // Compute a stable key that changes when the major content view changes.
  // This drives the animate-fadeIn-200 transition wrapper below.
  // Use spaceRouteId (the URL-facing identifier) rather than the canonical UUID
  // so slug resolution doesn't trigger an unnecessary remount.
  let contentKey: string;
  if (spaceRouteId) {
    contentKey = `space-${spaceRouteId}-${spaceViewMode}`;
  } else if (navSection === 'spaces') {
    contentKey = 'spaces';
  } else if (sessionId) {
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
            routeSpaceId={spaceRouteId}
            viewMode={spaceViewMode}
            sessionViewId={spaceSessionViewId}
            taskViewId={spaceTaskViewId}
          />
        </Suspense>
      );
    }

    // /spaces route: sidebar owns the list; main pane stays quiet.
    if (navSection === 'spaces') {
      return <SpacesHome />;
    }

    // A session route always shows the chat. For an id that isn't in the cached
    // sessions list (deep link to a stale/deleted id, or list not yet loaded),
    // ChatContainer's store load resolves the state — including the unavailable
    // view for a confirmed-missing id — instead of falling through to the list.
    if (sessionId) {
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
                {settingsSection === 'voice' && <VoiceSettings />}
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
    return <SpacesHome />;
  }

  // Wrap content in a keyed div so Preact remounts it (and replays animate-fadeIn-200)
  // whenever the major content view changes.
  // BottomTabBar sits outside the keyed div so it never remounts on view transitions.
  // The VoiceSurfaceContext identifies this as the PRIMARY surface for voice
  // composers (chat views and Space panes alike): the global recording chip
  // needs to know which surface owns a recording when two surfaces display
  // the same session, and the recorder needs the surface's Space to stamp
  // recordings started here. The agent overlay provides its own context.
  return (
    <VoiceSurfaceContext.Provider
      value={{ surfaceId: 'primary', spaceId: spaceId ?? null, taskId: null }}
    >
      <div key={contentKey} class="flex-1 flex flex-col overflow-hidden animate-fadeIn-200">
        {renderContent()}
      </div>
      <VoiceRecordingIndicator />
      <BottomTabBar inline />
    </VoiceSurfaceContext.Provider>
  );
}
