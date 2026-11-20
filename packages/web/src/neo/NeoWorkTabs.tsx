import { t } from '../lib/i18n/index.ts';

export type NeoWorkTab = 'inbox' | 'scheduled' | 'goals';
const TABS: readonly NeoWorkTab[] = ['inbox', 'scheduled', 'goals'];

export function NeoWorkTabs({
  selected,
  onSelect,
}: {
  selected: NeoWorkTab;
  onSelect: (tab: NeoWorkTab) => void;
}) {
  return (
    <nav
      aria-label={t('live.workTabs')}
      class="mt-1 flex gap-5 border-b border-line"
      data-work-tabs
    >
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
  );
}
