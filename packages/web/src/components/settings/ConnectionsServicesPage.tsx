import type { ComponentChildren } from 'preact';
import { t, type MessageKey } from '../../lib/i18n/index.ts';
import { navigateToSettings } from '../../lib/router.ts';
import type { SettingsSection } from '../../lib/signals.ts';
import { cn } from '../../lib/utils.ts';

const TABS: Array<{ section: SettingsSection; label: MessageKey }> = [
  { section: 'providers', label: 'connections.tabProviders' },
  { section: 'connections', label: 'connections.tabAccounts' },
  { section: 'devices', label: 'connections.tabDevices' },
  { section: 'remote-daemons', label: 'connections.tabRemoteDaemons' },
];

export const isConnectionsSection = (section: SettingsSection) =>
  TABS.some((tab) => tab.section === section);

export function ConnectionsServicesPage({
  section,
  children,
}: {
  section: SettingsSection;
  children: ComponentChildren;
}) {
  return (
    <>
      <nav
        aria-label={t('connections.page')}
        class="mb-5 flex flex-wrap gap-1 border-b border-line"
      >
        {TABS.map((tab) => (
          <button
            key={tab.section}
            type="button"
            aria-current={tab.section === section ? 'page' : undefined}
            onClick={() => navigateToSettings(tab.section)}
            class={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab.section === section
                ? 'border-accent text-fg'
                : 'border-transparent text-fg-muted hover:text-fg-soft'
            )}
          >
            {t(tab.label)}
          </button>
        ))}
      </nav>
      {children}
    </>
  );
}
