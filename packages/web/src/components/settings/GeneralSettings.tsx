import { useEffect, useState } from 'preact/hooks';
import { globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { resolveChatDisplayMode } from '../sdk/chat-display-mode.ts';
import { FORM_CHECKBOX_CLASS } from '../ui/FormField.tsx';
import type {
  ChatDisplayMode,
  PermissionMode,
  ThinkingLevel,
  SettingSource,
} from '@hyperneo/shared';
import { MAX_GITHUB_POLLING_INTERVAL_SECONDS, normalizeThinkingLevel } from '@hyperneo/shared';
import {
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsToggle,
} from './SettingsSection.tsx';

const PERMISSION_MODE_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'acceptEdits', label: 'Accept Edits' },
  { value: 'plan', label: 'Plan Mode' },
  { value: 'delegate', label: 'Delegate' },
];

const CHAT_DISPLAY_MODE_OPTIONS = [
  { value: 'compact', label: 'Compact' },
  { value: 'full', label: 'Full' },
  { value: 'minimal', label: 'Minimal' },
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
  const [localPermissionMode, setLocalPermissionMode] = useState<PermissionMode>(
    settings?.permissionMode ?? 'default'
  );
  const [localAutoScroll, setLocalAutoScroll] = useState(settings?.autoScroll ?? true);
  const [localDisplayMode, setLocalDisplayMode] = useState<ChatDisplayMode>(
    resolveChatDisplayMode(undefined, settings?.chatDisplayMode)
  );
  const [localGitHubPollingInterval, setLocalGitHubPollingInterval] = useState(
    String(settings?.githubPollingInterval ?? 120)
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
      setLocalPermissionMode(settings.permissionMode ?? 'default');
      setLocalAutoScroll(settings.autoScroll ?? true);
      setLocalDisplayMode(resolveChatDisplayMode(undefined, settings.chatDisplayMode));
      setLocalGitHubPollingInterval(String(settings.githubPollingInterval ?? 120));
      setLocalThinkingLevel(normalizeThinkingLevel(settings.thinkingLevel));
      setLocalShowArchived(settings.showArchived ?? false);
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

  const handleDisplayModeChange = async (value: string) => {
    const mode = value as ChatDisplayMode;
    setLocalDisplayMode(mode);
    setIsUpdating(true);
    try {
      await updateGlobalSettings({ chatDisplayMode: mode });
    } catch {
      toast.error('Failed to update default chat view');
      setLocalDisplayMode(resolveChatDisplayMode(undefined, settings?.chatDisplayMode));
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
      <SettingsGroup>
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
            class="w-24 rounded-md border border-line bg-surface px-2.5 py-1 text-[13px] text-fg-soft focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
        </SettingsRow>

        <SettingsRow
          label="Default chat view"
          description="Compact shows one line per tool call, Minimal only replies; each chat can override it"
        >
          <SettingsSelect
            value={localDisplayMode}
            onChange={handleDisplayModeChange}
            options={CHAT_DISPLAY_MODE_OPTIONS}
            disabled={isUpdating}
          />
        </SettingsRow>

        <SettingsRow label="Auto-scroll" description="Auto-scroll to new messages">
          <SettingsToggle
            checked={localAutoScroll}
            onChange={handleAutoScrollChange}
            disabled={isUpdating}
          />
        </SettingsRow>

        <SettingsRow
          label="Show Archived Sessions"
          description="Display archived sessions in lists"
        >
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
