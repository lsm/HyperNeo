import type { ComponentChildren } from 'preact';
import { Suspense } from 'preact/compat';
import { navigateToSettings } from '../../lib/router.ts';
import type { SettingsSection } from '../../lib/signals.ts';
import { cn } from '../../lib/utils.ts';

const TABS: Array<{ section: SettingsSection; label: string }> = [
  { section: 'skills', label: 'Skills' },
  { section: 'app-mcp-servers', label: 'MCP Servers' },
  { section: 'coding-pack', label: 'Coding pack' },
];

export const isCapabilitiesSection = (section: SettingsSection) =>
  TABS.some((tab) => tab.section === section);

export function CapabilitiesPage({
  section,
  fallback,
  children,
}: {
  section: SettingsSection;
  fallback?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <>
      <nav aria-label="Capabilities" class="mb-5 flex flex-wrap gap-1 border-b border-line">
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
            {tab.label}
          </button>
        ))}
      </nav>
      <Suspense fallback={fallback}>{children}</Suspense>
    </>
  );
}
