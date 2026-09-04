import type { SettingSource } from '@hyperneo/shared';
import { spaceStore } from '../../lib/space-store';
import { globalSettings } from '../../lib/state';

const SETTING_SOURCE_OPTIONS: Array<{ value: SettingSource; label: string; hint: string }> = [
  { value: 'user', label: 'User settings', hint: '(~/.claude/settings.json)' },
  { value: 'project', label: 'Project settings + CLAUDE.md', hint: '(.claude/settings.json)' },
  { value: 'local', label: 'Local settings', hint: '(.claude/settings.local.json)' },
];

export function getInheritedSettingSources(): SettingSource[] {
  return (
    spaceStore.space?.value?.settingSources ??
    globalSettings.value?.settingSources ?? ['user', 'project', 'local']
  );
}

export interface SettingSourcesEditorProps {
  value?: SettingSource[] | null;
  onChange: (next: SettingSource[]) => void;
  disabled?: boolean;
}

export function SettingSourcesEditor({
  value,
  onChange,
  disabled = false,
}: SettingSourcesEditorProps) {
  const effective = value ?? getInheritedSettingSources();

  const toggle = (source: SettingSource) => {
    onChange(
      effective.includes(source) ? effective.filter((s) => s !== source) : [...effective, source]
    );
  };

  return (
    <div class="space-y-1.5">
      {SETTING_SOURCE_OPTIONS.map((option) => (
        <label key={option.value} class="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={effective.includes(option.value)}
            onChange={() => toggle(option.value)}
            disabled={disabled}
            class="w-4 h-4 rounded border-line-strong text-accent focus:ring-accent focus:ring-offset-bg"
          />
          <span class="text-sm text-fg-soft">{option.label}</span>
          <span class="text-xs text-fg-muted">{option.hint}</span>
        </label>
      ))}
    </div>
  );
}
