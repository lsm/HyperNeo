import { ModelsSettings } from './ModelsSettings.tsx';
import { NeoMutedSessionsSettings } from './NeoMutedSessionsSettings.tsx';
import { NeoRulesSettings } from './NeoRulesSettings.tsx';
import { NeoWorkerPermissionSettings } from './NeoWorkerPermissionSettings.tsx';

export function NeoModelSettings() {
  return (
    <>
      <ModelsSettings neoOnly />
      <div class="mt-4">
        <NeoRulesSettings />
      </div>
      <NeoMutedSessionsSettings />
      <NeoWorkerPermissionSettings />
    </>
  );
}
