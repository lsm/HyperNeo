import { SessionSchedules } from '../components/SessionSchedules.tsx';
import { lazy, Suspense } from 'preact/compat';
import { useEffect } from 'preact/hooks';
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
import { navigateToSessions } from '../lib/router.ts';
import { webExtension, webExtensionDeclined } from '../lib/web-extensions.ts';
import { BottomTabBar } from './BottomTabBar.tsx';
import { VoiceRecordingIndicator } from '../components/voice/VoiceRecordingIndicator.tsx';
import { VoiceSurfaceContext } from '../hooks/useVoiceRecorder';
import { MobileMenuButton } from '../components/ui/MobileMenuButton.tsx';

const ChatContainer = lazy(() => import('./ChatContainer.tsx'));
const SessionsPage = lazy(() =>
  import('./SessionsPage.tsx').then((m) => ({ default: m.SessionsPage }))
);

const GeneralSettings = lazy(() =>
  import('../components/settings/GeneralSettings.tsx').then((m) => ({ default: m.GeneralSettings }))
);
const AppearanceSettings = lazy(() =>
  import('../components/settings/AppearanceSettings.tsx').then((m) => ({
    default: m.AppearanceSettings,
  }))
);
const ProvidersSettings = lazy(() =>
  import('../components/settings/ProvidersSettings.tsx').then((m) => ({
    default: m.ProvidersSettings,
  }))
);
const ConnectionsSettings = lazy(() =>
  import('../components/settings/ConnectionsSettings.tsx').then((m) => ({
    default: m.ConnectionsSettings,
  }))
);
const VoiceSettings = lazy(() =>
  import('../components/settings/VoiceSettings.tsx').then((m) => ({ default: m.VoiceSettings }))
);
const ExaSettings = lazy(() =>
  import('../components/settings/ExaSettings.tsx').then((m) => ({ default: m.ExaSettings }))
);
const AppMcpServersSettings = lazy(() =>
  import('../components/settings/AppMcpServersSettings.tsx').then((m) => ({
    default: m.AppMcpServersSettings,
  }))
);
const DevicesSettings = lazy(() =>
  import('../components/settings/DevicesSettings.tsx').then((m) => ({
    default: m.DevicesSettings,
  }))
);
const RemoteDaemonsSettings = lazy(() =>
  import('../components/settings/RemoteDaemonsSettings.tsx').then((m) => ({
    default: m.RemoteDaemonsSettings,
  }))
);
const SkillsRegistry = lazy(() =>
  import('../components/settings/SkillsRegistry.tsx').then((m) => ({ default: m.SkillsRegistry }))
);
const CodingPackSettings = lazy(() =>
  import('../components/settings/CodingPackSettings.tsx').then((m) => ({
    default: m.CodingPackSettings,
  }))
);
const NeoModelSettings = lazy(() =>
  import('../components/settings/NeoModelSettings.tsx').then((m) => ({
    default: m.NeoModelSettings,
  }))
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

const lazyFallback = (
  <div class="flex-1 flex items-center justify-center bg-app-content">
    <div class="text-xs text-fg-faint">Loading...</div>
  </div>
);

export default function MainContent() {
  const sessionId = currentSessionIdSignal.value;
  const spaceRouteId = currentSpaceIdSignal.value;
  const spaceId = currentSpaceCanonicalIdSignal.value ?? spaceRouteId;
  const space = webExtension('space');
  const spaceDeclined = webExtensionDeclined('space');
  const spaceSessionViewId = currentSpaceSessionIdSignal.value;
  const spaceTaskViewId = currentSpaceTaskIdSignal.value;
  const spaceViewMode = currentSpaceViewModeSignal.value;
  const navSection = navSectionSignal.value;
  const settingsSection = settingsSectionSignal.value;

  useEffect(() => {
    if (spaceDeclined && navSection === 'spaces') navigateToSessions(true);
  }, [spaceDeclined, navSection]);

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
    contentKey = 'settings';
  } else {
    contentKey = 'home';
  }

  function renderContent() {
    if (spaceId && space) {
      return (
        <Suspense fallback={lazyFallback}>
          <space.SpaceIsland
            spaceId={spaceId}
            routeSpaceId={spaceRouteId}
            viewMode={spaceViewMode}
            sessionViewId={spaceSessionViewId}
            taskViewId={spaceTaskViewId}
          />
        </Suspense>
      );
    }

    if (navSection === 'spaces') {
      return space && <space.SpacesHome />;
    }

    if (sessionId) {
      return (
        <Suspense fallback={lazyFallback}>
          <ChatContainer
            key={sessionId}
            sessionId={sessionId}
            headerExtra={<SessionSchedules sessionId={sessionId} />}
          />
        </Suspense>
      );
    }

    if (navSection === 'chats') {
      return (
        <Suspense fallback={lazyFallback}>
          <SessionsPage />
        </Suspense>
      );
    }

    if (navSection === 'settings') {
      return (
        <div class="flex-1 flex flex-col bg-app-content overflow-hidden">
          <div
            class="relative z-10 flex h-[52px] flex-shrink-0 items-center bg-app-content px-4"
            data-tauri-drag-region
          >
            <div class="flex min-w-0 flex-1 items-center gap-3" data-tauri-drag-region>
              <MobileMenuButton />
              <h2 class="min-w-0 truncate text-sm font-semibold text-fg" data-tauri-drag-region>
                Global Settings
              </h2>
            </div>
          </div>
          <div class="settings-theme scrollbar-dark min-h-0 flex-1 overflow-y-auto px-4 py-4 pr-3 sm:px-6 sm:py-5 sm:pr-4">
            <div class="mx-auto w-full max-w-5xl">
              <Suspense fallback={lazyFallback}>
                {settingsSection === 'general' && <GeneralSettings />}
                {settingsSection === 'appearance' && <AppearanceSettings />}
                {settingsSection === 'providers' && <ProvidersSettings />}
                {settingsSection === 'connections' && <ConnectionsSettings />}
                {settingsSection === 'voice' && <VoiceSettings />}
                {settingsSection === 'exa' && <ExaSettings />}
                {settingsSection === 'app-mcp-servers' && <AppMcpServersSettings />}
                {settingsSection === 'devices' && <DevicesSettings />}
                {settingsSection === 'remote-daemons' && <RemoteDaemonsSettings />}
                {settingsSection === 'skills' && <SkillsRegistry />}
                {settingsSection === 'coding-pack' && <CodingPackSettings />}
                {settingsSection === 'neo-model' && <NeoModelSettings />}
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

    return space && <space.SpacesHome />;
  }

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
