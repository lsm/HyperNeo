import { SettingsSection, SettingsRow, SettingsSelect } from './SettingsSection.tsx';
import { themeSetting, setTheme, type ThemeSetting } from '../../lib/theme.ts';

const THEME_OPTIONS: Array<{ value: ThemeSetting; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

export function AppearanceSettings() {
  return (
    <SettingsSection title="Appearance">
      <SettingsRow
        label="Theme"
        description="Follow your OS appearance, or pin HyperNeo to a theme."
      >
        <SettingsSelect
          value={themeSetting.value}
          onChange={(value) => setTheme(value as ThemeSetting)}
          options={THEME_OPTIONS}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
