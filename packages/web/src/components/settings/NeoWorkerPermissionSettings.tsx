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

  const save = async (workerPermissionMode: NeoWorkerPermissionMode) => {
    setSaving(true);
    try {
      await updateGlobalSettings({ neo: { ...neo, workerPermissionMode } });
    } catch {
      toast.error('Failed to update Claude worker permission');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Claude workers">
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
            onChange={(event) =>
              save((event.target as HTMLSelectElement).value as NeoWorkerPermissionMode)
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
      <SettingsGroup>
        <SettingsRow
          label="Worker Unix sockets"
          description="New worker sessions may connect to these human-approved sockets."
        >
          {(settings.workerUnixSockets ?? []).map((path) => (
            <div key={path}>
              <code>{path}</code>
              <button
                type="button"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await updateGlobalSettings({
                      workerUnixSockets: settings.workerUnixSockets!.filter(
                        (socket) => socket !== path
                      ),
                    });
                  } catch {
                    toast.error('Failed to remove worker socket');
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                Remove
              </button>
            </div>
          ))}
          {!settings.workerUnixSockets?.length && <span>No sockets allowed</span>}
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
