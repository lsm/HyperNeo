import { NeoRelaySendersSettings } from './NeoRelaySendersSettings.tsx';
import { neoWorkerPermissionMode } from '@hyperneo/shared/types/settings';
import { navigateToSettings } from '../../lib/router.ts';
import { globalSettings } from '../../lib/state.ts';
import { Button } from '../ui/Button.tsx';
import { ModelsSettings } from './ModelsSettings.tsx';
import { NeoMutedSessionsSettings } from './NeoMutedSessionsSettings.tsx';
import { NeoRulesSettings } from './NeoRulesSettings.tsx';
import { NeoTodoLimitsSettings } from './NeoTodoLimitsSettings.tsx';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsSection.tsx';

function NeoRelatedSettings() {
  const settings = globalSettings.value;
  const permission = neoWorkerPermissionMode(settings?.neo);
  const unset = settings?.neo?.workerPermissionMode ? '' : ' (not set)';
  return (
    <SettingsSection title="Related settings">
      <SettingsGroup>
        <SettingsRow
          label="Workers Neo starts"
          description={`Claude worker permission: ${permission}${unset} · Worker sandbox: ${settings?.workerSandbox ?? 'off'}`}
        >
          <Button variant="secondary" size="sm" onClick={() => navigateToSettings('harness')}>
            Sessions & Harness →
          </Button>
        </SettingsRow>
        <SettingsRow label="Coding pack" description="Merge rules, review bot and human sign-off">
          <Button variant="secondary" size="sm" onClick={() => navigateToSettings('coding-pack')}>
            Coding pack settings →
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}

export function NeoModelSettings() {
  return (
    <>
      <ModelsSettings neoOnly />
      <div class="mt-4">
        <NeoRulesSettings />
      </div>
      <NeoTodoLimitsSettings />
      <NeoRelaySendersSettings />
      <NeoMutedSessionsSettings />
      <NeoRelatedSettings />
    </>
  );
}
