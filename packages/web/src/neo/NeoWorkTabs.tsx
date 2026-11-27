import type { ComponentChildren } from 'preact';
import { t } from '../lib/i18n/index.ts';

export type NeoWorkTab = 'inbox' | 'scheduled' | 'goals';
const TABS: readonly NeoWorkTab[] = ['inbox', 'scheduled', 'goals'];

export function NeoWorkTabs({
  selected,
  onSelect,
  trailing,
  search,
  sheet,
}: {
  selected: NeoWorkTab;
  onSelect: (tab: NeoWorkTab) => void;
  trailing?: ComponentChildren;
  search?: ComponentChildren;
  sheet?: boolean;
}) {
  return (
    <div
      class={`neo-work-toolbar flex shrink-0 items-center gap-2 border-b border-line ${
        sheet ? 'pt-3' : 'mt-1'
      }`}
    >
      {search ? (
        <div class="neo-work-toolbar-search -mt-1 flex min-w-0 flex-1 pb-1">{search}</div>
      ) : (
        <nav aria-label={t('live.workTabs')} class="flex min-w-0 flex-1 gap-5" data-work-tabs>
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={selected === tab}
              onClick={() => onSelect(tab)}
              class={`-mb-px border-b-2 pb-2 text-sm font-medium ${
                selected === tab
                  ? 'border-accent text-fg'
                  : 'border-transparent text-fg-muted hover:text-fg'
              }`}
            >
              {t(`live.tab.${tab}`)}
            </button>
          ))}
        </nav>
      )}
      {trailing && (
        <div class="neo-work-toolbar-actions -mt-1 flex shrink-0 items-center gap-1 pb-1">
          {trailing}
        </div>
      )}
    </div>
  );
}
