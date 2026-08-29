import { useState, useEffect, useMemo } from 'preact/hooks';
import {
  navSectionSignal,
  contextPanelOpenSignal,
  currentSpaceIdSignal,
  currentSpaceCanonicalIdSignal,
  currentSpaceConfigureTabSignal,
  currentSpaceTasksFilterTabSignal,
  currentSpaceViewModeSignal,
  settingsSectionSignal,
  type SettingsSection,
} from '../lib/signals.ts';
import {
  navigateToSettings,
  navigateToSpaces,
  navigateToSpace,
  navigateToSpaceAgent,
  navigateToSpaceConfigure,
  navigateToSpaceSessions,
  navigateToSpaceGoals,
  navigateToSpaceEvolve,
  navigateToSpaceMemories,
  navigateToSpaceTasks,
} from '../lib/router.ts';
import { cn } from '../lib/utils.ts';
import { SpaceCreateDialog } from '../components/space/SpaceCreateDialog.tsx';
import { DaemonStatusIndicator } from '../components/DaemonStatusIndicator.tsx';
import { SectionSwitcher } from '../components/SectionSwitcher.tsx';
import { SessionsSidebar } from './SessionsSidebar.tsx';
import { SpaceDetailPanel } from './SpaceDetailPanel.tsx';
import { spaceStore } from '../lib/space-store.ts';

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  icon: string;
  accent: string;
}> = [
  { id: 'general', label: 'General', icon: 'settings', accent: 'text-accent-soft bg-accent/15' },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'palette',
    accent: 'text-cat-purple bg-cat-purple/15',
  },
  { id: 'providers', label: 'Providers', icon: 'cloud', accent: 'text-info-soft bg-sky-500/15' },
  { id: 'voice', label: 'Voice', icon: 'mic', accent: 'text-cat-rose bg-rose-500/15' },
  {
    id: 'app-mcp-servers',
    label: 'MCP Servers',
    icon: 'server',
    accent: 'text-violet-300 bg-cat-violet/15',
  },
  { id: 'skills', label: 'Skills', icon: 'skills', accent: 'text-success-soft bg-success/15' },
  { id: 'models', label: 'Models', icon: 'swap', accent: 'text-cat-cyan bg-cat-cyan/15' },
  { id: 'usage', label: 'Usage', icon: 'chart', accent: 'text-warning bg-warning/15' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', accent: 'text-cat-pink bg-pink-500/15' },
  { id: 'about', label: 'About', icon: 'info', accent: 'text-fg-soft bg-fill' },
];

function SectionIcon({ type }: { type: string }) {
  switch (type) {
    case 'settings':
      return (
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      );
    case 'server':
      return (
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"
          />
        </svg>
      );
    case 'cloud':
      return (
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
          />
        </svg>
      );
    case 'mic':
      return (
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M12 14a3 3 0 003-3V6a3 3 0 10-6 0v5a3 3 0 003 3zM17 11a5 5 0 01-10 0m5 5v4m-3 0h6"
          />
        </svg>
      );
    case 'plug':
      return (
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>
      );
    case 'chart':
      return (
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
          />
        </svg>
      );
    case 'info':
      return (
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      );
    case 'swap':
      return (
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
          />
        </svg>
      );
    case 'skills':
      return (
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"
          />
        </svg>
      );
    case 'keyboard':
      return (
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M3 8a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8zm4 2h.01M11 10h.01M15 10h.01M7 14h10"
          />
        </svg>
      );
    case 'palette':
      return (
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M12 3a9 9 0 100 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16a5 5 0 005-5c0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"
          />
        </svg>
      );
    default:
      return null;
  }
}

export function ContextPanel() {
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);

  const navSection = navSectionSignal.value;
  const isPanelOpen = contextPanelOpenSignal.value;

  useEffect(() => {
    if (navSection === 'spaces') {
      spaceStore.initGlobalList().catch(() => {});
    }
  }, [navSection]);
  const activeSettingsSection = settingsSectionSignal.value;
  const currentSpaceId = currentSpaceIdSignal.value;
  const currentSpaceCanonicalId = currentSpaceCanonicalIdSignal.value;
  const detailPanelSpaceId = currentSpaceCanonicalId ?? currentSpaceId;
  const currentSpaceConfigureTab = currentSpaceConfigureTabSignal.value;
  const currentSpaceTasksFilterTab = currentSpaceTasksFilterTabSignal.value;
  const currentSpaceViewMode = currentSpaceViewModeSignal.value;
  const isSpaceDetail = navSection === 'spaces' && currentSpaceId !== null;
  const headerTitle = spaceStore.space.value?.name ?? 'Space';

  const handlePanelClose = () => {
    contextPanelOpenSignal.value = false;
  };

  const handleSpaceSwitch = (spaceId: string) => {
    switch (currentSpaceViewMode) {
      case 'agents':
        navigateToSpaceAgent(spaceId);
        break;
      case 'tasks':
        navigateToSpaceTasks(spaceId, currentSpaceTasksFilterTab);
        break;
      case 'sessions':
        navigateToSpaceSessions(spaceId);
        break;
      case 'goals':
        navigateToSpaceGoals(spaceId);
        break;
      case 'memories':
        navigateToSpaceMemories(spaceId);
        break;
      case 'forge':
        navigateToSpaceEvolve(spaceId);
        break;
      case 'configure':
        navigateToSpaceConfigure(spaceId, currentSpaceConfigureTab);
        break;
      case 'overview':
      default:
        navigateToSpace(spaceId);
        break;
    }
    contextPanelOpenSignal.value = false;
  };

  const handleCreateSpace = () => {
    setCreateSpaceOpen(true);
    contextPanelOpenSignal.value = false;
  };

  const handleSettingsNav = (section?: SettingsSection) => {
    navigateToSettings(section);
    contextPanelOpenSignal.value = false;
  };

  const activeSpaces = useMemo(
    () => spaceStore.spacesWithTasks.value.filter((space) => space.status === 'active'),
    [spaceStore.spacesWithTasks.value]
  );

  const spaceSwitcherContent = (
    <div class="flex-1 overflow-y-auto py-2" data-testid="space-switcher">
      {activeSpaces.length === 0 ? (
        <div class="px-4 py-8 text-center">
          <svg
            class="w-10 h-10 mx-auto text-fg-muted mb-3"
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
          <p class="text-sm font-medium text-fg-soft">No spaces yet</p>
          <p class="text-xs text-fg-muted mt-1">
            Create a Space to organize agents, missions, and project context.
          </p>
        </div>
      ) : (
        <nav class="px-2 space-y-1" aria-label="Switch spaces">
          {activeSpaces.map((space) => {
            const isCurrent = space.id === currentSpaceId;
            return (
              <button
                key={space.id}
                type="button"
                onClick={() => handleSpaceSwitch(space.slug)}
                aria-current={isCurrent ? 'page' : undefined}
                class={cn(
                  'w-full rounded-lg px-3 py-3 flex items-center gap-3 text-left transition-colors',
                  isCurrent
                    ? 'bg-fill border border-transparent text-fg'
                    : 'border border-transparent text-fg-muted hover:bg-fill-soft hover:text-fg'
                )}
              >
                <svg
                  class="w-5 h-5 flex-shrink-0 text-fg-muted"
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
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium truncate">{space.name}</div>
                  {space.description && (
                    <div class="text-xs text-fg-muted truncate mt-0.5">{space.description}</div>
                  )}
                </div>
                {isCurrent && (
                  <svg
                    class="w-4 h-4 text-fg-soft flex-shrink-0"
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
                )}
              </button>
            );
          })}
        </nav>
      )}
      <div class="px-4 pt-4 pb-6">
        <button
          type="button"
          onClick={handleCreateSpace}
          class="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-line-strong hover:border-line-strong hover:bg-fill-soft text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
          Create Space
        </button>
      </div>
    </div>
  );

  return (
    <>
      {isPanelOpen && (
        <div
          class="fixed inset-0 bg-black/50 z-35 md:hidden cursor-pointer"
          onClick={handlePanelClose}
        />
      )}

      <div
        class={`
					fixed md:relative
					top-0 left-0 md:left-auto
					h-safe-screen md:h-full w-70
					bg-app-sidebar
					flex flex-col
					pt-safe md:pt-0
					z-40 md:z-auto
					max-md:transition-transform max-md:duration-300 max-md:ease-in-out
					${isPanelOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'}
					overflow-hidden
				`}
      >
        <div class="desktop-titlebar-row" data-tauri-drag-region>
          <div class="desktop-traffic-light-space" aria-hidden="true" data-tauri-drag-region />
          <SectionSwitcher onClose={handlePanelClose} variant="titlebar" />
        </div>
        <div class="desktop-standard-switcher">
          <SectionSwitcher
            onClose={handlePanelClose}
            showDivider={!isSpaceDetail}
            compact={isSpaceDetail}
          />
        </div>

        {isSpaceDetail && (
          <div class="hidden h-9 items-center gap-1 border-b px-4 md:flex border-line">
            <button
              type="button"
              onClick={() => navigateToSpaces()}
              class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-fill-soft hover:text-fg"
              title="Back to Spaces"
              aria-label="Back to Spaces"
            >
              <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <h2 class="min-w-0 flex-1 text-sm font-semibold text-fg truncate">{headerTitle}</h2>
            <button
              type="button"
              onClick={() => navigateToSpaceConfigure(currentSpaceId!)}
              class={cn(
                'ml-1 p-1.5 rounded-lg transition-colors flex-shrink-0',
                currentSpaceViewMode === 'configure'
                  ? 'bg-fill text-fg'
                  : 'text-fg-muted hover:bg-fill-soft hover:text-fg'
              )}
              title="Configure space"
              aria-label="Configure space"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </button>
          </div>
        )}

        <div
          key={navSection + (isSpaceDetail ? '-space-detail' : '')}
          class="flex-1 overflow-hidden flex flex-col animate-fadeIn"
        >
          {navSection === 'chats' && (
            <SessionsSidebar onSessionSelect={() => (contextPanelOpenSignal.value = false)} />
          )}
          {navSection === 'spaces' && !isSpaceDetail && spaceSwitcherContent}
          {navSection === 'spaces' && isSpaceDetail && (
            <div class="flex-1 flex flex-col overflow-hidden">
              <div class="md:hidden px-2 pt-2 pb-1 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    navigateToSpaces();
                    contextPanelOpenSignal.value = false;
                  }}
                  class="flex items-center gap-1.5 px-2 py-1.5 rounded-lg w-full text-sm text-fg-muted hover:text-fg hover:bg-fill-soft transition-colors"
                >
                  <svg
                    class="w-4 h-4 flex-shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width={2}
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                  All Spaces
                </button>
              </div>
              <SpaceDetailPanel
                spaceId={detailPanelSpaceId!}
                navigationSpaceId={currentSpaceId!}
                onNavigate={() => (contextPanelOpenSignal.value = false)}
              />
            </div>
          )}
          {navSection === 'settings' && (
            <div class="flex-1 overflow-y-auto scrollbar-dark px-2 py-3">
              <div class="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-muted">
                Settings
              </div>
              <nav class="space-y-1" aria-label="Settings sections">
                {SETTINGS_SECTIONS.map((section) => {
                  const isActive = activeSettingsSection === section.id;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => handleSettingsNav(section.id)}
                      class={cn(
                        'w-full rounded-lg px-2.5 py-2 flex items-center gap-2.5 text-left transition-colors duration-150',
                        isActive
                          ? 'bg-fill text-fg'
                          : 'text-fg-muted hover:text-fg-soft hover:bg-fill-soft'
                      )}
                    >
                      <span
                        class={cn(
                          'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md',
                          isActive ? section.accent : 'bg-white/[0.03] text-fg-muted'
                        )}
                      >
                        <SectionIcon type={section.icon} />
                      </span>
                      <span class="truncate text-sm font-medium">{section.label}</span>
                    </button>
                  );
                })}
              </nav>
            </div>
          )}
        </div>

        <div class="flex h-[53px] flex-shrink-0 items-center gap-2 px-2 border-t border-line">
          <button
            type="button"
            onClick={() => handleSettingsNav()}
            class={cn(
              'flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors',
              navSection === 'settings'
                ? 'bg-fill text-fg'
                : 'text-fg-muted hover:bg-fill-soft hover:text-fg'
            )}
          >
            <svg class="w-4 h-4 text-current" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            <span>Settings</span>
          </button>
          <DaemonStatusIndicator showLabel={isSpaceDetail} />
        </div>
      </div>
      <SpaceCreateDialog isOpen={createSpaceOpen} onClose={() => setCreateSpaceOpen(false)} />
    </>
  );
}
