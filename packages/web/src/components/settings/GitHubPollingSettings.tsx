import { useEffect, useState } from 'preact/hooks';
import { MAX_GITHUB_POLLING_INTERVAL_SECONDS } from '@hyperneo/shared';
import { globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsSection.tsx';

export function GitHubPollingSettings() {
  const settings = globalSettings.value;
  const [localGitHubPollingInterval, setLocalGitHubPollingInterval] = useState(
    String(settings?.githubPollingInterval ?? 120)
  );
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    if (settings) setLocalGitHubPollingInterval(String(settings.githubPollingInterval ?? 120));
  }, [settings]);

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

  return (
    <SettingsSection title="GitHub">
      <SettingsGroup>
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
              setLocalGitHubPollingInterval((event.target as HTMLInputElement).value)
            }
            onBlur={handleGitHubPollingIntervalBlur}
            disabled={isUpdating}
            class="w-24 rounded-md border border-line bg-surface px-2.5 py-1 text-[13px] text-fg-soft focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
