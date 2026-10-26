import { useState } from 'preact/hooks';
import {
  NEO_WORKER_PERMISSION_MODES,
  neoWorkerPermissionMode,
  type NeoWorkerPermissionMode,
} from '@hyperneo/shared/types/settings';
import { globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsSection.tsx';

export function NeoWorkerPermissionSettings() {
  const settings = globalSettings.value;
  const neo = settings?.neo;
  const [saving, setSaving] = useState(false);
  const effective = neoWorkerPermissionMode(neo);
  if (!settings) return null;

  const save = async (updates: Parameters<typeof updateGlobalSettings>[0]) => {
    setSaving(true);
    try {
      await updateGlobalSettings(updates);
    } catch {
      toast.error('Failed to update worker settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Workers">
      <SettingsGroup>
        <SettingsRow
          label="Claude worker permission"
          description="Claude Code workers Neo starts from now on use this mode; running sessions keep theirs."
        >
          <select
            aria-label="Claude worker permission"
            class="st-select"
            value={effective}
            disabled={saving}
            onChange={({ currentTarget }) =>
              save({
                neo: {
                  ...neo,
                  workerPermissionMode: currentTarget.value as NeoWorkerPermissionMode,
                },
              })
            }
          >
            {NEO_WORKER_PERMISSION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode === effective && !neo?.workerPermissionMode ? `${mode} (not set)` : mode}
              </option>
            ))}
          </select>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
