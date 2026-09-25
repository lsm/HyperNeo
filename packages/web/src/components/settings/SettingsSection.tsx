import { ComponentChildren } from 'preact';
import { cn } from '../../lib/utils.ts';

export interface SettingsSectionProps {
  id?: string;
  title: ComponentChildren;
  description?: string;
  actions?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
}

export function SettingsSection({
  id,
  title,
  description,
  actions,
  children,
  class: className,
}: SettingsSectionProps) {
  return (
    <section id={id} class={cn('scroll-mt-4 pb-8', className)}>
      <div class="mb-3 flex items-end justify-between gap-4 px-1">
        <div class="min-w-0">
          <h3 class="text-sm font-semibold text-fg">{title}</h3>
          {description && <p class="mt-0.5 text-xs text-fg-muted">{description}</p>}
        </div>
        {actions && <div class="flex flex-shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div class="space-y-4">{children}</div>
    </section>
  );
}

export function SettingsGroup({ children }: { children: ComponentChildren }) {
  return (
    <div class="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {children}
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
        'px-4 py-3',
        layout === 'inline'
          ? 'flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4'
          : 'space-y-2.5'
      )}
    >
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-medium text-fg">{label}</div>
        {description && <div class="text-xs text-fg-muted mt-0.5">{description}</div>}
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
        'bg-surface border border-line rounded-md px-2.5 py-1 text-[13px] text-fg-soft',
        'focus:outline-none focus:border-accent',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'min-w-[120px]'
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
        'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-bg',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        checked ? 'bg-accent' : 'bg-fill-strong'
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
