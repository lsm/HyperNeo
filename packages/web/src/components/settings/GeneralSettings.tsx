import { useEffect, useState } from 'preact/hooks';
import { globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import type { PermissionMode, ThinkingLevel, SettingSource } from '@neokai/shared';
import { normalizeThinkingLevel } from '@neokai/shared';
import {
  SettingsSection,
  SettingsRow,
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
  const [localThinkingLevel, setLocalThinkingLevel] = useState<ThinkingLevel>(
    normalizeThinkingLevel(settings?.thinkingLevel)
  );
  const [localShowArchived, setLocalShowArchived] = useState(settings?.showArchived ?? false);
  const [localSettingSources, setLocalSettingSources] = useState<SettingSource[]>(
    settings?.settingSources ?? ['user', 'project', 'local']
  );
  const [isUpdating, setIsUpdating] = useState(false);

  // Sync local state when global settings change
  useEffect(() => {
    if (settings) {
      setLocalModel(settings.model ?? 'sonnet');
      setLocalPermissionMode(settings.permissionMode ?? 'default');
      setLocalAutoScroll(settings.autoScroll ?? true);
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
      // Revert on error
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
      // Revert on error
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
      // Revert on error
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
