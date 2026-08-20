import type { PermissionMode, SettingSource, ThinkingLevel } from '@hyperneo/shared';
import { MAX_GITHUB_POLLING_INTERVAL_SECONDS, normalizeThinkingLevel } from '@hyperneo/shared';
import { useEffect, useState } from 'preact/hooks';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { globalSettings } from '../../lib/state.ts';
import { toast } from '../../lib/toast.ts';
import {
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsToggle,
} from './SettingsSection.tsx';

const MODEL_OPTIONS = [
  { value: 'sonnet', label: 'Claude Sonnet 4' },
  { value: 'opus', label: 'Claude Opus 4' },
  { value: 'haiku', label: 'Claude Haiku 3.5' },
];

const PERMISSION_MODE_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'acceptEdits', label: 'Accept Edits' },
  { value: 'plan', label: 'Plan Mode' },
  { value: 'delegate', label: 'Delegate' },
];

const THINKING_LEVEL_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'think8k', label: 'Think 8k' },
  { value: 'think16k', label: 'Think 16k' },
  { value: 'think24k', label: 'Think 24k' },
  { value: 'think32k', label: 'Think 32k' },
];

export function GeneralSettings() {
  const settings = globalSettings.value;
  const [localModel, setLocalModel] = useState(settings?.model ?? 'sonnet');
  const [localPermissionMode, setLocalPermissionMode] = useState<PermissionMode>(
    settings?.permissionMode ?? 'default'
  );
  const [localAutoScroll, setLocalAutoScroll] = useState(settings?.autoScroll ?? true);
  const [localGitHubPollingInterval, setLocalGitHubPollingInterval] = useState(
    String(settings?.githubPollingInterval ?? 120)
  );
  const [localSdkMessageRetentionDays, setLocalSdkMessageRetentionDays] = useState(
    settings?.sdkMessageRetentionDays != null ? String(settings.sdkMessageRetentionDays) : ''
  );
  const [localThinkingLevel, setLocalThinkingLevel] = useState<ThinkingLevel>(
    normalizeThinkingLevel(settings?.thinkingLevel)
  );
  const [localShowArchived, setLocalShowArchived] = useState(settings?.showArchived ?? false);
  const [localSettingSources, setLocalSettingSources] = useState<SettingSource[]>(
    settings?.settingSources ?? ['user', 'project', 'local']
  );
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    if (settings) {
      setLocalModel(settings.model ?? 'sonnet');
      setLocalPermissionMode(settings.permissionMode ?? 'default');
      setLocalAutoScroll(settings.autoScroll ?? true);
      setLocalGitHubPollingInterval(String(settings.githubPollingInterval ?? 120));
      setLocalSdkMessageRetentionDays(
        settings.sdkMessageRetentionDays != null ? String(settings.sdkMessageRetentionDays) : ''
      );
      setLocalThinkingLevel(normalizeThinkingLevel(settings.thinkingLevel));
      setLocalShowArchived(settings.showArchived ?? false);
      setLocalSettingSources(settings.settingSources ?? ['user', 'project', 'local']);
    }
  }, [settings]);

  const handleModelChange = async (value: string) => {
    setLocalModel(value);
    setIsUpdating(true);
    try {
      await updateGlobalSettings({ model: value });
    } catch {
      toast.error('Failed to update model setting');
      setLocalModel(settings?.model ?? 'sonnet');
    } finally {
      setIsUpdating(false);
    }
  };

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

  const handleAutoScrollChange = async (value: boolean) => {
    setLocalAutoScroll(value);
    setIsUpdating(true);
    try {
      await updateGlobalSettings({ autoScroll: value });
    } catch {
      toast.error('Failed to update auto-scroll setting');
      setLocalAutoScroll(settings?.autoScroll ?? true);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleThinkingLevelChange = async (value: string) => {
    const level = value as ThinkingLevel;
    setLocalThinkingLevel(level);
    setIsUpdating(true);
    try {
      await updateGlobalSettings({ thinkingLevel: level });
    } catch {
      toast.error('Failed to update thinking level');
      setLocalThinkingLevel(normalizeThinkingLevel(settings?.thinkingLevel));
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

  const handleSdkMessageRetentionDaysChange = (value: string) => {
    setLocalSdkMessageRetentionDays(value);
  };

  const handleSdkMessageRetentionDaysBlur = async () => {
    const trimmed = localSdkMessageRetentionDays.trim();
    const current = settings?.sdkMessageRetentionDays;
    if (trimmed === '') {
      setLocalSdkMessageRetentionDays(current != null ? String(current) : '');
      return;
    }

    const days = Number(trimmed);
    if (!Number.isInteger(days) || days < 0) {
      toast.error('Message retention must be a whole number of days, or empty to disable');
      setLocalSdkMessageRetentionDays(current != null ? String(current) : '');
      return;
    }

    setLocalSdkMessageRetentionDays(String(days));
    if (days === current) return;

    setIsUpdating(true);
    try {
      await updateGlobalSettings({ sdkMessageRetentionDays: days });
    } catch {
      toast.error('Failed to update message retention');
      setLocalSdkMessageRetentionDays(current != null ? String(current) : '');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleShowArchivedChange = async (value: boolean) => {
    setLocalShowArchived(value);
    setIsUpdating(true);
    try {
      await updateGlobalSettings({ showArchived: value });
    } catch {
      toast.error('Failed to update archived sessions setting');
      setLocalShowArchived(settings?.showArchived ?? false);
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
      <SettingsRow label="Default Model" description="Model for new sessions">
        <SettingsSelect
          value={localModel}
          onChange={handleModelChange}
          options={MODEL_OPTIONS}
          disabled={isUpdating}
        />
      </SettingsRow>

      <SettingsRow label="Permission Mode" description="How Claude asks for permissions">
        <SettingsSelect
          value={localPermissionMode}
          onChange={handlePermissionModeChange}
          options={PERMISSION_MODE_OPTIONS}
          disabled={isUpdating}
        />
      </SettingsRow>

      <SettingsRow label="Default Thinking Level" description="Thinking budget for new sessions">
        <SettingsSelect
          value={localThinkingLevel}
          onChange={handleThinkingLevelChange}
          options={THINKING_LEVEL_OPTIONS}
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
          class="w-24 rounded-lg border border-white/[0.08] bg-dark-800 px-3 py-1.5 text-sm text-gray-200 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </SettingsRow>

      <SettingsRow
        label="Message retention (days)"
        description="Delete messages in archived sessions older than this many days. Empty or 0 disables."
      >
        <input
          type="number"
          min="0"
          step="1"
          placeholder="disabled"
          value={localSdkMessageRetentionDays}
          onInput={(event) =>
            handleSdkMessageRetentionDaysChange((event.target as HTMLInputElement).value)
          }
          onBlur={handleSdkMessageRetentionDaysBlur}
          disabled={isUpdating}
          class="w-24 rounded-lg border border-white/[0.08] bg-dark-800 px-3 py-1.5 text-sm text-gray-200 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </SettingsRow>

      <SettingsRow label="Auto-scroll" description="Auto-scroll to new messages">
        <SettingsToggle
          checked={localAutoScroll}
          onChange={handleAutoScrollChange}
          disabled={isUpdating}
        />
      </SettingsRow>

      <SettingsRow label="Show Archived Sessions" description="Display archived sessions in lists">
        <SettingsToggle
          checked={localShowArchived}
          onChange={handleShowArchivedChange}
          disabled={isUpdating}
        />
      </SettingsRow>

      <SettingsRow
        label="Setting Sources"
        description="Which on-disk settings files the SDK loads"
        layout="stacked"
      >
        <div class="grid gap-2 sm:grid-cols-3">
          <label class="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border border-white/[0.08] bg-dark-900/40 px-3 py-2.5">
            <input
              type="checkbox"
              checked={localSettingSources.includes('user')}
              onChange={() => toggleSettingSource('user')}
              disabled={isUpdating}
              class="mt-0.5 h-4 w-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
            />
            <span class="min-w-0">
              <span class="block text-sm text-gray-200">User settings</span>
              <span class="block truncate text-xs text-gray-500">~/.claude/settings.json</span>
            </span>
          </label>
          <label class="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border border-white/[0.08] bg-dark-900/40 px-3 py-2.5">
            <input
              type="checkbox"
              checked={localSettingSources.includes('project')}
              onChange={() => toggleSettingSource('project')}
              disabled={isUpdating}
              class="mt-0.5 h-4 w-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
            />
            <span class="min-w-0">
              <span class="block text-sm text-gray-200">Project settings</span>
              <span class="block truncate text-xs text-gray-500">.claude/settings.json</span>
            </span>
          </label>
          <label class="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border border-white/[0.08] bg-dark-900/40 px-3 py-2.5">
            <input
              type="checkbox"
              checked={localSettingSources.includes('local')}
              onChange={() => toggleSettingSource('local')}
              disabled={isUpdating}
              class="mt-0.5 h-4 w-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
            />
            <span class="min-w-0">
              <span class="block text-sm text-gray-200">Local settings</span>
              <span class="block truncate text-xs text-gray-500">.claude/settings.local.json</span>
            </span>
          </label>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
