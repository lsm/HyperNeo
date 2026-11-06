import { useEffect, useState } from 'preact/hooks';
import type { PermissionMode, SettingSource } from '@hyperneo/shared';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { globalSettings } from '../../lib/state.ts';
import { toast } from '../../lib/toast.ts';
import { FORM_CHECKBOX_CLASS } from '../ui/FormField.tsx';
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSelect } from './SettingsSection.tsx';

const PERMISSION_MODE_OPTIONS = [
  { value: 'default', label: 'bypassPermissions (Default)' },
  { value: 'acceptEdits', label: 'acceptEdits' },
  { value: 'plan', label: 'plan' },
];

function permissionModeOptions(saved: string) {
  if (PERMISSION_MODE_OPTIONS.some((option) => option.value === saved))
    return PERMISSION_MODE_OPTIONS;
  const label =
    saved === 'bypassPermissions' ? saved : `${saved} (legacy, compatibility unconfirmed)`;
  return [...PERMISSION_MODE_OPTIONS, { value: saved, label }];
}

export function HyperNeoSessionSettings() {
  const settings = globalSettings.value;
  const [localPermissionMode, setLocalPermissionMode] = useState<PermissionMode>(
    settings?.permissionMode ?? 'default'
  );
  const [localSettingSources, setLocalSettingSources] = useState<SettingSource[]>(
    settings?.settingSources ?? ['user', 'project', 'local']
  );
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    if (settings) {
      setLocalPermissionMode(settings.permissionMode ?? 'default');
      setLocalSettingSources(settings.settingSources ?? ['user', 'project', 'local']);
    }
  }, [settings]);

  const handlePermissionModeChange = async (value: string) => {
    const mode = value as PermissionMode;
    setLocalPermissionMode(mode);
    setIsUpdating(true);
    try {
      await updateGlobalSettings({ permissionMode: mode });
    } catch {
      toast.error('Failed to update permission mode');
      setLocalPermissionMode(settings?.permissionMode ?? 'default');
    } finally {
      setIsUpdating(false);
    }
  };

  const toggleSettingSource = async (source: SettingSource) => {
    const next = localSettingSources.includes(source)
      ? localSettingSources.filter((s) => s !== source)
      : [...localSettingSources, source];
    setLocalSettingSources(next);
    setIsUpdating(true);
    try {
      await updateGlobalSettings({ settingSources: next });
    } catch {
      toast.error('Failed to update setting sources');
      setLocalSettingSources(settings?.settingSources ?? ['user', 'project', 'local']);
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <SettingsSection title="HyperNeo session permissions">
      <SettingsGroup>
        <SettingsRow
          label="Permission Mode"
          description="Default or unset runs new HyperNeo SDK sessions with bypassPermissions."
        >
          <SettingsSelect
            value={localPermissionMode}
            onChange={handlePermissionModeChange}
            options={permissionModeOptions(localPermissionMode)}
            disabled={isUpdating}
          />
        </SettingsRow>

        <SettingsRow
          label="Setting Sources"
          description="Which on-disk settings files the SDK loads"
          layout="stacked"
        >
          <div class="grid gap-2 sm:grid-cols-3">
            <label class="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2 transition-colors hover:border-line-strong">
              <input
                type="checkbox"
                checked={localSettingSources.includes('user')}
                onChange={() => toggleSettingSource('user')}
                disabled={isUpdating}
                class={FORM_CHECKBOX_CLASS}
              />
              <span class="min-w-0">
                <span class="block text-xs font-medium text-fg-soft">User settings</span>
                <span class="block truncate font-mono text-[11px] text-fg-faint">
                  ~/.claude/settings.json
                </span>
              </span>
            </label>
            <label class="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2 transition-colors hover:border-line-strong">
              <input
                type="checkbox"
                checked={localSettingSources.includes('project')}
                onChange={() => toggleSettingSource('project')}
                disabled={isUpdating}
                class={FORM_CHECKBOX_CLASS}
              />
              <span class="min-w-0">
                <span class="block text-xs font-medium text-fg-soft">Project settings</span>
                <span class="block truncate font-mono text-[11px] text-fg-faint">
                  .claude/settings.json
                </span>
              </span>
            </label>
            <label class="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2 transition-colors hover:border-line-strong">
              <input
                type="checkbox"
                checked={localSettingSources.includes('local')}
                onChange={() => toggleSettingSource('local')}
                disabled={isUpdating}
                class={FORM_CHECKBOX_CLASS}
              />
              <span class="min-w-0">
                <span class="block text-xs font-medium text-fg-soft">Local settings</span>
                <span class="block truncate font-mono text-[11px] text-fg-faint">
                  .claude/settings.local.json
                </span>
              </span>
            </label>
          </div>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
