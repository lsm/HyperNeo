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
    <section id={id} class={cn('st-sec', className)}>
      <div class="st-sec-head">
        <div class="min-w-0">
          <h3 class="st-sec-title">{title}</h3>
          {description && <p class="st-sec-desc">{description}</p>}
        </div>
        {actions && <div class="st-sec-actions">{actions}</div>}
      </div>
      <div class="st-sec-body">{children}</div>
    </section>
  );
}

export function SettingsGroup({ children }: { children: ComponentChildren }) {
  return <div class="st-group">{children}</div>;
}

export function SettingsDangerGroup({ children }: { children: ComponentChildren }) {
  return <div class="st-group st-group-danger">{children}</div>;
}

export interface SettingsRowProps {
  label: string;
  description?: string;
  children: ComponentChildren;
  layout?: 'inline' | 'stacked';
}

export function SettingsRow({ label, description, children, layout = 'inline' }: SettingsRowProps) {
  return (
    <div class={cn('st-row', layout === 'stacked' && 'st-row-stacked')}>
      <div class="st-row-label">
        {label}
        {description && <div class="st-row-desc">{description}</div>}
      </div>
      <div class="st-row-ctl">{children}</div>
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
      class="st-select"
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
  'data-testid'?: string;
}

export function SettingsToggle({
  checked,
  onChange,
  disabled,
  'data-testid': testId,
}: SettingsToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      class={cn('st-switch', checked && 'st-switch-on')}
      data-testid={testId}
    />
  );
}
