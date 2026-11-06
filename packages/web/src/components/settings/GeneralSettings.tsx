import { useEffect, useState } from 'preact/hooks';
import { globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { FORM_CHECKBOX_CLASS } from '../ui/FormField.tsx';
import { type PermissionMode, type SettingSource } from '@hyperneo/shared';
import { MAX_GITHUB_POLLING_INTERVAL_SECONDS } from '@hyperneo/shared';
import { SettingsSection, SettingsGroup, SettingsRow, SettingsSelect } from './SettingsSection.tsx';

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

export function GeneralSettings() {
  const settings = globalSettings.value;
  const [localPermissionMode, setLocalPermissionMode] = useState<PermissionMode>(
    settings?.permissionMode ?? 'default'
  );
  const [localGitHubPollingInterval, setLocalGitHubPollingInterval] = useState(
    String(settings?.githubPollingInterval ?? 120)
  );
  const [localSettingSources, setLocalSettingSources] = useState<SettingSource[]>(
    settings?.settingSources ?? ['user', 'project', 'local']
  );
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    if (settings) {
      setLocalPermissionMode(settings.permissionMode ?? 'default');
      setLocalGitHubPollingInterval(String(settings.githubPollingInterval ?? 120));
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

  const handleGitHubPollingIntervalChange = (value: string) => {
    setLocalGitHubPollingInterval(value);
  };

  const handleGitHubPollingIntervalBlur = async () => {
    const trimmed = localGitHubPollingInterval.trim();
    const current = settings?.githubPollingInterval ?? 120;
    if (trimmed === '') {
      setLocalGitHubPollingInterval(String(current));
      return;
    }

    const interval = Number(trimmed);
    if (
      !Number.isInteger(interval) ||
      interval < 0 ||
      interval > MAX_GITHUB_POLLING_INTERVAL_SECONDS
    ) {
      toast.error(
        `GitHub polling interval must be a whole number between 0 and ${MAX_GITHUB_POLLING_INTERVAL_SECONDS}`
      );
      setLocalGitHubPollingInterval(String(current));
      return;
    }

    setLocalGitHubPollingInterval(String(interval));
    if (interval === current) return;

    setIsUpdating(true);
    try {
      await updateGlobalSettings({ githubPollingInterval: interval });
    } catch {
      toast.error('Failed to update GitHub polling interval');
      setLocalGitHubPollingInterval(String(current));
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
    <SettingsSection title="General">
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
          label="GitHub polling interval (seconds)"
          description="How often to poll watched GitHub repositories; 0 disables polling."
        >
          <input
            type="number"
            min="0"
            max={MAX_GITHUB_POLLING_INTERVAL_SECONDS}
            step="1"
            placeholder="120"
            value={localGitHubPollingInterval}
            onInput={(event) =>
              handleGitHubPollingIntervalChange((event.target as HTMLInputElement).value)
            }
            onBlur={handleGitHubPollingIntervalBlur}
            disabled={isUpdating}
            class="w-24 rounded-md border border-line bg-surface px-2.5 py-1 text-[13px] text-fg-soft focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
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
