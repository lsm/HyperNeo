import { SessionSchedules } from '../components/SessionSchedules.tsx';
import { lazy, Suspense } from 'preact/compat';
import { useEffect } from 'preact/hooks';
import { currentSessionIdSignal, navSectionSignal, settingsSectionSignal } from '../lib/signals.ts';
import { navigateToSessions } from '../lib/router.ts';
import { webExtension, extensionNav } from '../lib/web-extensions.ts';
import { BottomTabBar } from './BottomTabBar.tsx';
import { VoiceRecordingIndicator } from '../components/voice/VoiceRecordingIndicator.tsx';
import { VoiceSurfaceContext } from '../hooks/useVoiceRecorder';
import { MobileMenuButton } from '../components/ui/MobileMenuButton.tsx';

import {
  ConnectionsServicesPage,
  isConnectionsSection,
} from '../components/settings/ConnectionsServicesPage.tsx';

const ChatContainer = lazy(() => import('./ChatContainer.tsx'));
const SessionsPage = lazy(() =>
  import('./SessionsPage.tsx').then((m) => ({ default: m.SessionsPage }))
);

const GeneralSettings = lazy(() =>
  import('../components/settings/GeneralSettings.tsx').then((m) => ({ default: m.GeneralSettings }))
);
const PreferencesSettings = lazy(() =>
  import('../components/settings/PreferencesSettings.tsx').then((m) => ({
    default: m.PreferencesSettings,
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
const PackSettings = lazy(() =>
  import('../components/settings/PackSettings.tsx').then((m) => ({
    default: m.PackSettings,
  }))
);
const NeoModelSettings = lazy(() =>
  import('../components/settings/NeoModelSettings.tsx').then((m) => ({
    default: m.NeoModelSettings,
  }))
);
const SessionsHarnessSettings = lazy(() =>
  import('../components/settings/SessionsHarnessSettings.tsx').then((m) => ({
    default: m.SessionsHarnessSettings,
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
  const navSection = navSectionSignal.value;
  const settingsSection = settingsSectionSignal.value;

  const extensions = extensionNav();
  const sectionHasOwner =
    navSection === 'chats' ||
    navSection === 'settings' ||
    extensions.some((nav) => nav.section === navSection);

  useEffect(() => {
    if (!sectionHasOwner) navigateToSessions(true);
  }, [sectionHasOwner]);

  const extensionView = extensions.flatMap((nav) => {
    const key = nav.contentKey();
    return key ? [{ key, extension: nav.extension }] : [];
  })[0];
  const ExtensionContent = extensionView && webExtension(extensionView.extension)?.shell.Content;

  let contentKey: string;
  if (extensionView) {
    contentKey = extensionView.key;
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
    if (extensionView) {
      return ExtensionContent ? <ExtensionContent fallback={lazyFallback} /> : lazyFallback;
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
                {settingsSection === 'preferences' && <PreferencesSettings />}
                {settingsSection === 'general' && <GeneralSettings />}
                {isConnectionsSection(settingsSection) && (
                  <ConnectionsServicesPage section={settingsSection} fallback={lazyFallback}>
                    {settingsSection === 'providers' && <ProvidersSettings />}
                    {settingsSection === 'connections' && <ConnectionsSettings />}
                    {settingsSection === 'devices' && <DevicesSettings />}
                    {settingsSection === 'remote-daemons' && <RemoteDaemonsSettings />}
                  </ConnectionsServicesPage>
                )}
                {settingsSection === 'voice' && <VoiceSettings />}
                {settingsSection === 'exa' && <ExaSettings />}
                {settingsSection === 'app-mcp-servers' && <AppMcpServersSettings />}
                {settingsSection === 'skills' && <SkillsRegistry />}
                {settingsSection === 'coding-pack' && <PackSettings />}
                {settingsSection === 'neo-model' && <NeoModelSettings />}
                {settingsSection === 'harness' && <SessionsHarnessSettings />}
                {settingsSection === 'usage' && <UsageAnalytics />}
                {settingsSection === 'shortcuts' && <ShortcutsSettings />}
                {settingsSection === 'about' && <AboutSection />}
              </Suspense>
            </div>
          </div>
        </div>
      );
    }

    return lazyFallback;
  }

  return (
    <VoiceSurfaceContext.Provider
      value={{
        surfaceId: 'primary',
        scopeId: extensionNav().flatMap((nav) => nav.voiceScope() ?? [])[0] ?? null,
        taskId: null,
      }}
    >
      <div key={contentKey} class="flex-1 flex flex-col overflow-hidden animate-fadeIn-200">
        {renderContent()}
      </div>
      <VoiceRecordingIndicator />
      <BottomTabBar inline />
    </VoiceSurfaceContext.Provider>
  );
}
