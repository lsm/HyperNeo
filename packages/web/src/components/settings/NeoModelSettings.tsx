import { ModelsSettings } from './ModelsSettings.tsx';
import { NeoWorkerPermissionSettings } from './NeoWorkerPermissionSettings.tsx';

export function NeoModelSettings() {
  return (
    <>
      <ModelsSettings neoOnly />
      <NeoWorkerPermissionSettings />
    </>
  );
}
