import { useEffect, useState } from 'preact/hooks';
import type { ChatDisplayMode } from '@hyperneo/shared';
import type { LanguageSetting } from '@hyperneo/shared/types/settings';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { globalSettings } from '../../lib/state.ts';
import { setTheme, themeSetting, type ThemeSetting } from '../../lib/theme.ts';
import { toast } from '../../lib/toast.ts';
import { resolveChatDisplayMode } from '../sdk/chat-display-mode.ts';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsToggle,
} from './SettingsSection.tsx';

const LANGUAGE_OPTIONS = [
  { value: 'system', label: 'Same as browser' },
  { value: 'en', label: 'English' },
  { value: 'zh-Hans', label: '简体中文' },
];

const THEME_OPTIONS: Array<{ value: ThemeSetting; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const CHAT_DISPLAY_MODE_OPTIONS = [
  { value: 'compact', label: 'Compact' },
  { value: 'full', label: 'Full' },
  { value: 'minimal', label: 'Minimal' },
];

export function PreferencesSettings() {
  const settings = globalSettings.value;
  const [localLanguage, setLocalLanguage] = useState<LanguageSetting>(
    settings?.language ?? 'system'
  );
  const [localDisplayMode, setLocalDisplayMode] = useState<ChatDisplayMode>(
    resolveChatDisplayMode(undefined, settings?.chatDisplayMode)
  );
  const [localShowArchived, setLocalShowArchived] = useState(settings?.showArchived ?? false);
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    if (settings) {
      setLocalLanguage(settings.language ?? 'system');
      setLocalDisplayMode(resolveChatDisplayMode(undefined, settings.chatDisplayMode));
      setLocalShowArchived(settings.showArchived ?? false);
    }
  }, [settings]);

  const handleLanguageChange = async (value: string) => {
    const language = value as LanguageSetting;
    setLocalLanguage(language);
    setIsUpdating(true);
    try {
      await updateGlobalSettings({ language });
    } catch {
      toast.error('Failed to update language');
      setLocalLanguage(settings?.language ?? 'system');
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

  return (
    <SettingsSection title="Preferences">
      <SettingsGroup>
        <SettingsRow
          label="Language"
          description="Language for Neo on the web and on iOS. Most Settings labels stay in English."
        >
          <SettingsSelect
            value={localLanguage}
            onChange={handleLanguageChange}
            options={LANGUAGE_OPTIONS}
            disabled={isUpdating}
          />
        </SettingsRow>

        <SettingsRow
          label="Theme"
          description="Follow your OS appearance, or pin HyperNeo to a theme. Saved in this browser only."
        >
          <SettingsSelect
            value={themeSetting.value}
            onChange={(value) => setTheme(value as ThemeSetting)}
            options={THEME_OPTIONS}
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
      </SettingsGroup>
    </SettingsSection>
  );
}
