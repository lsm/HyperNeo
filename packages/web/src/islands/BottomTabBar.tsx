import type { ComponentType } from 'preact';
import { useEffect } from 'preact/hooks';
import { navSectionSignal } from '../lib/signals.ts';
import { navigateToSessions, navigateToSettings } from '../lib/router.ts';
import { extensionNav } from '../lib/web-extensions';

interface TabItem {
  id: string;
  label: string;
  icon: ComponentType;
  open: () => void;
}

const ChatsIcon = () => (
  <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
    />
  </svg>
);

const SettingsIcon = () => (
  <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

const GLOBAL_BOTTOM_TABS: TabItem[] = [
  { id: 'chats', label: 'Chats', icon: ChatsIcon, open: navigateToSessions },
  { id: 'settings', label: 'Settings', icon: SettingsIcon, open: navigateToSettings },
];

const BOTTOM_BAR_HEIGHT = 53;

export function BottomTabBar({ inline }: { inline?: boolean } = {}) {
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');

    const updateHeight = () => {
      document.documentElement.style.setProperty(
        '--bottom-bar-height',
        mq.matches ? BOTTOM_BAR_HEIGHT + 'px' : '0px'
      );
    };

    updateHeight();
    mq.addEventListener('change', updateHeight);

    return () => {
      mq.removeEventListener('change', updateHeight);
      document.documentElement.style.setProperty('--bottom-bar-height', '0px');
    };
  }, []);

  const navSection = navSectionSignal.value;
  const extensions = extensionNav();
  const context = extensions.flatMap((nav) => nav.contextTabs() ?? [])[0] ?? null;
  const tabs = context?.tabs ?? [
    ...extensions.map(({ section, label, icon, open }) => ({ id: section, label, icon, open })),
    ...GLOBAL_BOTTOM_TABS,
  ];
  const isTabActive = (tab: TabItem & { active?: boolean }) => tab.active ?? navSection === tab.id;

  return (
    <div
      data-testid="bottom-tab-bar"
      class={
        inline
          ? 'flex md:hidden flex-shrink-0 bg-surface/90 backdrop-blur-md pb-safe'
          : 'flex md:hidden fixed bottom-0 left-0 right-0 z-50 bg-surface/90 backdrop-blur-md pb-safe'
      }
      role="tablist"
      aria-label={context?.label ?? 'Main navigation'}
    >
      <div
        class="flex w-full border-t border-line transition-opacity duration-200 ease-out"
        style={{ height: BOTTOM_BAR_HEIGHT + 'px' }}
        key={context?.label ?? 'global'}
      >
        {tabs.map((tab) => {
          const isActive = isTabActive(tab);

          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-label={tab.label}
              onClick={tab.open}
              class={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 transition-colors duration-150 ${
                isActive ? 'text-cat-indigo' : 'text-fg-muted active:text-fg-soft'
              }`}
            >
              <tab.icon />
              <span class="text-[10px] font-medium leading-none">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
