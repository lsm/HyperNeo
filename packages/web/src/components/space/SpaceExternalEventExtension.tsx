import type { ExtensionStatus } from './space-external-event-types.ts';
import { formatCapabilities } from './space-external-event-values.ts';
import { cn } from '../../lib/utils.ts';
import { SettingsToggle } from '../settings/SettingsSection.tsx';

interface ExtensionCardProps {
  extension: ExtensionStatus;
  disabled: boolean;
  onToggle: (enabled: boolean) => Promise<void>;
}

export function ExtensionCard({ extension, disabled, onToggle }: ExtensionCardProps) {
  const capabilities = formatCapabilities(extension.config.capabilities);
  return (
    <div class={cn('st-trow', disabled && 'opacity-60')}>
      <div class="st-trow-body">
        <div class="flex flex-wrap items-center gap-2">
          <span class="st-trow-name capitalize">{extension.source}</span>
          <span class={extension.status === 'started' ? 'st-chip st-chip-ok' : 'st-chip'}>
            {extension.status}
          </span>
          {capabilities.map((capability) => (
            <span key={capability} class="st-chip">
              {capability}
            </span>
          ))}
          {capabilities.length === 0 && (
            <span class="text-xs text-fg-muted">No capabilities enabled</span>
          )}
        </div>
      </div>
      <span class="st-trow-acts">
        <SettingsToggle
          checked={extension.config.globallyEnabled}
          disabled={disabled}
          onChange={(next) => void onToggle(next)}
          data-testid={`extension-toggle-${extension.source}`}
        />
      </span>
    </div>
  );
}
