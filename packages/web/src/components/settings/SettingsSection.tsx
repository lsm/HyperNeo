import { ComponentChildren } from 'preact';
import { cn } from '../../lib/utils.ts';

export interface SettingsSectionProps {
  title: string;
  children: ComponentChildren;
  class?: string;
}

export function SettingsSection({ title, children, class: className }: SettingsSectionProps) {
  return (
    <div class={cn('space-y-3 pb-6', className)}>
      <div class="flex items-center gap-2 px-1">
        <span class="h-4 w-1 rounded-full bg-blue-500/80" aria-hidden="true" />
        <h3 class="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">{title}</h3>
      </div>
      <div class="space-y-2">{children}</div>
    </div>
  );
}

export interface SettingsRowProps {
  label: string;
  description?: string;
  children: ComponentChildren;
  layout?: 'inline' | 'stacked';
}

export function SettingsRow({ label, description, children, layout = 'inline' }: SettingsRowProps) {
  return (
    <div
      class={cn(
        'rounded-lg border border-white/[0.08] bg-white/[0.025] px-4 py-3',
        layout === 'inline'
          ? 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4'
          : 'space-y-3'
      )}
    >
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-gray-200">{label}</div>
        {description && <div class="text-xs text-gray-500 mt-0.5">{description}</div>}
      </div>
      <div class={cn(layout === 'inline' ? 'flex-shrink-0' : 'min-w-0')}>{children}</div>
    </div>
  );
}

export interface SettingsSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}

export function SettingsSelect({ value, onChange, options, disabled }: SettingsSelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
      disabled={disabled}
      class={cn(
        'bg-dark-800 border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-gray-200',
        'focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'min-w-[140px]'
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export interface SettingsToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function SettingsToggle({ checked, onChange, disabled }: SettingsToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      class={cn(
        'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full',
        'transition-colors duration-200 ease-in-out',
        'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-dark-950',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        checked ? 'bg-blue-600' : 'bg-dark-700'
      )}
    >
      <span
        class={cn(
          'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0',
          'transition duration-200 ease-in-out',
          'mt-0.5 ml-0.5',
          checked ? 'translate-x-4' : 'translate-x-0'
        )}
      />
    </button>
  );
}
