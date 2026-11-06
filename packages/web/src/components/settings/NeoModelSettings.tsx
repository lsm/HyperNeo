import { ModelsSettings } from './ModelsSettings.tsx';
import { NeoMutedSessionsSettings } from './NeoMutedSessionsSettings.tsx';
import { NeoRulesSettings } from './NeoRulesSettings.tsx';

export function NeoModelSettings() {
  return (
    <>
      <ModelsSettings neoOnly />
      <div class="mt-4">
        <NeoRulesSettings />
      </div>
      <NeoMutedSessionsSettings />
    </>
  );
}
